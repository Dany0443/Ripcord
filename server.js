require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const archiver = require('archiver');
const NodeID3 = require('node-id3');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

// check if ffmpeg is on the system, otherwise use the bundled one
let ffmpegPath = 'ffmpeg';
try {
    const checkFfmpeg = spawnSync('which', ['ffmpeg']);
    if (checkFfmpeg.status === 0 && checkFfmpeg.stdout.toString().trim()) {
        ffmpegPath = checkFfmpeg.stdout.toString().trim();
    } else if (ffmpegStatic) {
        ffmpegPath = ffmpegStatic;
    }
} catch (e) {
    if (ffmpegStatic) ffmpegPath = ffmpegStatic;
}
ffmpeg.setFfmpegPath(ffmpegPath);

// make sure yt-dlp is installed and in the system path
const checkYtdlp = spawnSync('yt-dlp', ['--version']);
const ytdlpAvailable = checkYtdlp.status === 0;
const ytdlpVersion = ytdlpAvailable ? checkYtdlp.stdout.toString().trim() : 'NOT INSTALLED';

// simple logger with timestamps and colors
const Logger = {
    _format: (level, msg) => {
        const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const colors = {
            INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m'
        };
        return `${colors[level] || ''}[${time}] [${level}]${colors.RESET} ${msg}`;
    },
    info: (msg) => console.log(Logger._format('INFO', msg)),
    success: (msg) => console.log(Logger._format('SUCCESS', msg)),
    warn: (msg) => console.log(Logger._format('WARN', msg)),
    error: (msg) => console.error(Logger._format('ERROR', msg))
};

Logger.info('Ripcord audio engine initializing');
Logger.info(`yt-dlp version: ${ytdlpVersion}`);
Logger.info(`ffmpeg path: ${ffmpegPath}`);

if (!ytdlpAvailable) {
    Logger.error('yt-dlp is not installed or not in PATH. Please install yt-dlp: https://github.com/yt-dlp/yt-dlp');
}

// optional cookies file if youtube starts blocking downloads
const COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || (fs.existsSync(path.join(__dirname, 'cookies.txt')) ? path.join(__dirname, 'cookies.txt') : null);
if (COOKIES_PATH) {
    Logger.info(`Using yt-dlp cookies from: ${COOKIES_PATH}`);
}

// simple download queue so we don't melt the cpu with too many conversions
class DownloadQueue {
    constructor(concurrency = 2) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    addTask(task) {
        this.queue.push(task);
        Logger.info(`[Queue] Task queued. Position: ${this.queue.length}. Running: ${this.running}/${this.concurrency}`);
        this.process();
    }

    process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const task = this.queue.shift();

        Promise.resolve(task())
            .catch(err => Logger.error(`[Queue] Task failed: ${err.message}`))
            .finally(() => {
                this.running--;
                this.process();
            });
    }
}

const concurrencyLimit = parseInt(process.env.DOWNLOAD_CONCURRENCY, 10) || 2;
const downloadQueue = new DownloadQueue(concurrencyLimit);

// set up the express app
const app = express();

// trust reverse proxy headers like nginx
app.set('trust proxy', 1);

app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
app.use(express.json());

// serve static files from the public folder
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// rate limiter so people cannot spam the api
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment and try again.' }
});
app.use('/api/', limiter);

// check if the link is a supported youtube or spotify url
function isSafeUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        return host.includes('youtube.com') || host.includes('youtu.be') || host.includes('spotify.com');
    } catch (e) {
        return false;
    }
}

// clean up filenames so they do not break the filesystem
function sanitizeFilename(name) {
    if (!name) return 'audio_track';
    return name.replace(/<[^>]*>|&nbsp;|&[a-z]+;|[\$`'";|&]|\.\.[/\\]|[\x00-\x1F\x7F]/g, '')
               .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
               .replace(/^\.+/, '')
               .replace(/\s+/g, ' ')
               .trim() || 'audio_track';
}

function sanitizeAsciiHeader(name) {
    const ascii = name.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
    return ascii || 'download';
}

// helper to delete temp files when we are done with them
function cleanupFiles(files) {
    if (!Array.isArray(files)) return;
    files.forEach(file => {
        try {
            if (file && fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } catch (e) {
            // ignore errors if the file is already gone
        }
    });
}

// grab the 11 character id from a youtube link
function getYouTubeVideoId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

function isYouTubeUrl(url) {
    return url.includes('youtube.com/watch') || url.includes('youtu.be/') || url.includes('youtube.com/shorts/') || url.includes('music.youtube.com/');
}

function isYouTubePlaylist(url) {
    return url.includes('youtube.com/playlist') || (url.includes('youtube.com/watch') && url.includes('list='));
}

// fetch youtube video info using oembed first
async function getYoutubeInfo(url) {
    const videoId = getYouTubeVideoId(url);
    const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '';
    let title = 'Unknown Title';
    let author = 'Unknown Channel';

    if (videoId) {
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const response = await axios.get(oembedUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 5000
            });
            if (response.status === 200 && response.data) {
                title = response.data.title || title;
                author = response.data.author_name || author;
            }
        } catch (error) {
            Logger.warn(`YouTube oEmbed warning for ${videoId}: ${error.message}`);
        }
    }
    return { title, author, thumbnail };
}

// list all songs in a youtube playlist without downloading them yet
async function getYoutubePlaylistData(url) {
    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '--flat-playlist',
            '--print', '%(playlist_title)s:::%(id)s:::%(title)s:::%(uploader)s',
            '--ignore-errors',
            '--no-abort-on-error',
            '--no-warnings'
        ];

        if (COOKIES_PATH) {
            ytdlpArgs.push('--cookies', COOKIES_PATH);
        }

        ytdlpArgs.push('--', url);

        const ytdlp = spawn('yt-dlp', ytdlpArgs);
        let output = '';

        const timeout = setTimeout(() => {
            ytdlp.kill();
            reject(new Error('Playlist metadata fetch timed out after 30 seconds.'));
        }, 30000);

        ytdlp.stdout.on('data', (data) => output += data.toString());
        ytdlp.stderr.on('data', (data) => Logger.warn(`yt-dlp playlist stderr: ${data.toString().trim()}`));

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 || output.length > 0) {
                const lines = output.trim().split('\n').filter(Boolean);
                let playlistName = 'YouTube Playlist';

                const tracks = lines.map((line, index) => {
                    const parts = line.split(':::');
                    const pName = parts[0];
                    const id = parts[1];

                    if (index === 0 && pName && pName !== 'NA') {
                        playlistName = pName;
                    }

                    if (!id || id === 'NA' || id.length < 11) return null;

                    return {
                        title: parts[2] || 'Unknown Track',
                        artist: parts[3] || 'Unknown Artist',
                        thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
                        url: `https://www.youtube.com/watch?v=${id}`
                    };
                }).filter(Boolean);

                if (tracks.length === 0) {
                    reject(new Error('Playlist is empty or videos are unavailable/private.'));
                } else {
                    resolve({ type: 'collection', name: playlistName, tracks });
                }
            } else {
                reject(new Error('Failed to fetch YouTube playlist tracks.'));
            }
        });

        ytdlp.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// grab song or playlist info by reading the spotify embed page
async function getSpotifyData(url) {
    const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error('Invalid Spotify link.');

    const type = match[1];
    const id = match[2];

    let coverImage = '';
    let collectionName = 'Spotify Collection';

    try {
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const oembedRes = await axios.get(oembedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 5000
        });
        if (oembedRes.status === 200 && oembedRes.data) {
            coverImage = oembedRes.data.thumbnail_url || '';
            collectionName = oembedRes.data.title || collectionName;
        }
    } catch (e) {
        Logger.warn(`Spotify oEmbed note: ${e.message}`);
    }

    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
    const response = await axios.get(embedUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 10000
    });

    const html = response.data;
    const jsonStrMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);

    const tracks = [];

    if (jsonStrMatch) {
        try {
            const data = JSON.parse(jsonStrMatch[1]);

            function findTracks(obj) {
                if (!obj || typeof obj !== 'object') return null;
                if (Array.isArray(obj.trackList) && obj.trackList.length > 0) return obj.trackList;
                if (obj.tracks && Array.isArray(obj.tracks.items) && obj.tracks.items.length > 0) {
                    return obj.tracks.items.map(i => i.track || i);
                }
                if (Array.isArray(obj.tracks) && obj.tracks.length > 0) return obj.tracks;
                for (const key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                        const found = findTracks(obj[key]);
                        if (found) return found;
                    }
                }
                return null;
            }

            if (type === 'track') {
                const entity = data?.props?.pageProps?.state?.data?.entity;
                const artistName = (entity?.artists && Array.isArray(entity.artists))
                    ? entity.artists.map(a => a.name).join(', ')
                    : 'Unknown Artist';
                tracks.push({
                    title: entity?.name || 'Unknown Track',
                    artist: artistName,
                    thumbnail: coverImage
                });
            } else {
                const rawTracks = findTracks(data);
                if (rawTracks && rawTracks.length > 0) {
                    rawTracks.forEach(t => {
                        const trackData = t.track || t;
                        const title = trackData.title || trackData.name || 'Unknown Track';
                        let trackArtists = 'Unknown Artist';
                        if (trackData.artists && Array.isArray(trackData.artists)) {
                            trackArtists = trackData.artists.map(a => (typeof a === 'string' ? a : a.name)).join(', ');
                        }
                        tracks.push({ title, artist: trackArtists, thumbnail: coverImage });
                    });
                }
            }
        } catch (parseErr) {
            Logger.warn(`JSON parse in Spotify failed, using meta fallback: ${parseErr.message}`);
        }
    }

    // fallback to regular meta tags if spotify's json data was empty
    if (tracks.length === 0 && type === 'track') {
        const titleMatch = html.match(/<meta property="og:title" content="(.*?)"/i) || html.match(/<title>(.*?)<\/title>/i);
        const descMatch = html.match(/<meta property="og:description" content="(.*?)"/i);
        const imageMatch = html.match(/<meta property="og:image" content="(.*?)"/i);

        let parsedTitle = titleMatch ? titleMatch[1] : 'Unknown Track';
        let parsedArtist = descMatch ? descMatch[1] : 'Unknown Artist';
        if (imageMatch && !coverImage) coverImage = imageMatch[1];

        // spotify titles usually look like Title · Artist
        if (parsedTitle.includes(' · ')) {
            const parts = parsedTitle.split(' · ');
            parsedTitle = parts[0];
            parsedArtist = parts[1];
        }

        tracks.push({
            title: parsedTitle.replace(/ - song and lyrics by.*$/i, '').trim(),
            artist: parsedArtist.replace(/Listen to.*on Spotify.*$/i, '').trim(),
            thumbnail: coverImage
        });
    }

    if (tracks.length === 0) {
        throw new Error('Unable to extract Spotify metadata. The track/playlist may be private or restricted.');
    }

    return { type, name: collectionName, tracks, thumbnail: coverImage };
}

// download the raw audio stream to a temp file using yt-dlp
async function downloadToTemp(targetUrl, extension = 'webm') {
    const tempPath = path.join(os.tmpdir(), `ripcord_${Date.now()}_${Math.random().toString(36).substring(7)}.${extension}`);

    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '-f', 'bestaudio/best',
            '--no-playlist',
            '--no-warnings',
            '--extractor-args', 'youtube:player_client=android,web'
        ];

        if (COOKIES_PATH) {
            ytdlpArgs.push('--cookies', COOKIES_PATH);
        }

        ytdlpArgs.push('-o', tempPath, '--', targetUrl);

        const ytdlp = spawn('yt-dlp', ytdlpArgs);

        const timeout = setTimeout(() => {
            ytdlp.kill();
            reject(new Error('Download timed out after 90 seconds.'));
        }, 90000);

        ytdlp.stderr.on('data', (data) => Logger.warn(`yt-dlp: ${data.toString().trim()}`));

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && fs.existsSync(tempPath)) {
                resolve(tempPath);
            } else {
                reject(new Error('yt-dlp was unable to extract this audio source.'));
            }
        });

        ytdlp.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// attach album cover art to flac or ogg files
function injectVorbisCoverArt(filePath, imgPath, format) {
    if (!fs.existsSync(imgPath) || !fs.existsSync(filePath)) return false;

    if (format === 'ogg') {
        try {
            const imgBuffer = fs.readFileSync(imgPath);
            const mimeType = 'image/jpeg';
            const mimeBuf = Buffer.from(mimeType, 'utf8');
            const descBuf = Buffer.from('', 'utf8');

            const picType = Buffer.alloc(4); picType.writeUInt32BE(3, 0);
            const mimeLen = Buffer.alloc(4); mimeLen.writeUInt32BE(mimeBuf.length, 0);
            const descLen = Buffer.alloc(4); descLen.writeUInt32BE(descBuf.length, 0);
            const width = Buffer.alloc(4); width.writeUInt32BE(0, 0);
            const height = Buffer.alloc(4); height.writeUInt32BE(0, 0);
            const depth = Buffer.alloc(4); depth.writeUInt32BE(0, 0);
            const colors = Buffer.alloc(4); colors.writeUInt32BE(0, 0);
            const imgLen = Buffer.alloc(4); imgLen.writeUInt32BE(imgBuffer.length, 0);

            const block = Buffer.concat([picType, mimeLen, mimeBuf, descLen, descBuf, width, height, depth, colors, imgLen, imgBuffer]);
            const base64Block = block.toString('base64');

            const readResult = spawnSync('vorbiscomment', ['-l', '-R', filePath]);
            if (readResult.error || readResult.status !== 0) return false;

            let comments = readResult.stdout.toString().split('\n');
            comments = comments.filter(c => c && !c.startsWith('metadata_block_picture='));
            comments.push(`metadata_block_picture=${base64Block}`);

            const tempCommentsFile = path.join(os.tmpdir(), `comments_${Date.now()}.txt`);
            fs.writeFileSync(tempCommentsFile, comments.join('\n'));
            const writeResult = spawnSync('vorbiscomment', ['-w', '-R', '-c', tempCommentsFile, filePath]);
            fs.unlinkSync(tempCommentsFile);

            return !writeResult.error && writeResult.status === 0;
        } catch (e) {
            return false;
        }
    } else if (format === 'flac') {
        try {
            spawnSync('metaflac', ['--remove', '--block-type=PICTURE', '--except-block-type=STREAMINFO', filePath]);
            const spec = `3||Front Cover||${imgPath}`;
            const writeResult = spawnSync('metaflac', [`--import-picture-from=${spec}`, filePath]);
            return !writeResult.error && writeResult.status === 0;
        } catch (e) {
            return false;
        }
    }
    return false;
}

// transcode the audio with ffmpeg and stream it directly to the user
async function processAndStreamAudio(target, bitrate, format, thumbnailUrl, res, filename = '', artist = '') {
    const tempFiles = [];

    // clean up temp files if the user closes their browser or cancels
    const onDisconnect = () => cleanupFiles(tempFiles);
    res.on('close', onDisconnect);

    try {
        Logger.info(`Downloading audio stream for: ${target}`);
        const tempAudioPath = await downloadToTemp(target, 'webm');
        tempFiles.push(tempAudioPath);

        let tempImgPath = '';
        if (thumbnailUrl) {
            try {
                const imgRes = await axios.get(thumbnailUrl, {
                    responseType: 'arraybuffer',
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 6000
                });
                if (imgRes.status === 200) {
                    tempImgPath = path.join(os.tmpdir(), `cover_${Date.now()}.jpg`);
                    fs.writeFileSync(tempImgPath, Buffer.from(imgRes.data));
                    tempFiles.push(tempImgPath);
                }
            } catch (imgErr) {
                Logger.warn(`Cover art fetch omitted: ${imgErr.message}`);
            }
        }

        const tempOutPath = path.join(os.tmpdir(), `out_${Date.now()}.${format}`);
        tempFiles.push(tempOutPath);

        const ffmpegFormatMap = { mp3: 'mp3', m4a: 'ipod', ogg: 'ogg', wav: 'wav', flac: 'flac' };
        const ffmpegFormat = ffmpegFormatMap[format] || 'mp3';

        Logger.info(`Encoding audio to [${format.toUpperCase()}] at ${bitrate} kbps`);
        await new Promise((resolve, reject) => {
            const ff = ffmpeg(tempAudioPath);
            const opts = ['-map', '0:a:0'];

            if (format === 'mp3') opts.push('-c:a', 'libmp3lame');
            else if (format === 'm4a') opts.push('-c:a', 'aac');
            else if (format === 'ogg') opts.push('-c:a', 'libvorbis');
            else if (format === 'wav') opts.push('-c:a', 'pcm_s16le');
            else if (format === 'flac') opts.push('-c:a', 'flac');

            const ffTimeout = setTimeout(() => {
                ff.kill('SIGKILL');
                reject(new Error('Audio encoding timed out.'));
            }, 60000);

            ff.outputOptions(opts)
              .audioBitrate(bitrate)
              .format(ffmpegFormat)
              .save(tempOutPath)
              .on('error', (err) => { clearTimeout(ffTimeout); reject(err); })
              .on('end', () => { clearTimeout(ffTimeout); resolve(); });
        });

        // attach the cover image to the converted audio
        if (tempImgPath && fs.existsSync(tempOutPath)) {
            if (format === 'm4a' || format === 'wav') {
                const taggedPath = path.join(os.tmpdir(), `tagged_${Date.now()}.${format}`);
                tempFiles.push(taggedPath);
                try {
                    let cmd = '';
                    if (format === 'wav') {
                        cmd = `ffmpeg -y -i "${tempOutPath}" -i "${tempImgPath}" -map 0:a -map 1:v -c:a copy -c:v mjpeg -id3v2_version 3 -metadata:s:v title="Album cover" "${taggedPath}"`;
                    } else if (format === 'm4a') {
                        cmd = `ffmpeg -y -i "${tempOutPath}" -i "${tempImgPath}" -map 0:a -map 1:v -c:a copy -c:v mjpeg -disposition:v attached_pic "${taggedPath}"`;
                    }
                    if (cmd) {
                        execSync(cmd, { stdio: 'ignore' });
                        if (fs.existsSync(taggedPath)) {
                            fs.copyFileSync(taggedPath, tempOutPath);
                        }
                    }
                } catch (e) {
                    Logger.warn(`Tagging command omitted: ${e.message}`);
                }
            } else if (format === 'ogg' || format === 'flac') {
                injectVorbisCoverArt(tempOutPath, tempImgPath, format);
            }
        }

        // add id3 tags and cover art for mp3 files
        if (format === 'mp3' && fs.existsSync(tempOutPath)) {
            try {
                const tags = {
                    title: filename || 'Track',
                    artist: artist || 'Unknown Artist'
                };
                if (tempImgPath && fs.existsSync(tempImgPath)) {
                    tags.image = {
                        mime: 'image/jpeg',
                        type: { id: 3, name: 'front cover' },
                        description: 'Cover Art',
                        imageBuffer: fs.readFileSync(tempImgPath)
                    };
                }
                const updatedBuffer = NodeID3.write(tags, fs.readFileSync(tempOutPath));
                fs.writeFileSync(tempOutPath, updatedBuffer);
            } catch (metaErr) {
                Logger.warn(`ID3 tag injection error: ${metaErr.message}`);
            }
        }

        Logger.success(`Encoding complete. Streaming ${format.toUpperCase()} to client`);
        const fileStat = fs.statSync(tempOutPath);
        res.setHeader('Content-Length', fileStat.size);

        const readStream = fs.createReadStream(tempOutPath);
        readStream.pipe(res);

        readStream.on('end', () => {
            res.removeListener('close', onDisconnect);
            cleanupFiles(tempFiles);
        });

    } catch (error) {
        Logger.error(`Audio processing error: ${error.message}`);
        res.removeListener('close', onDisconnect);
        cleanupFiles(tempFiles);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'Failed to process audio.' });
        }
    }
}

// convert one song so we can add it to the zip file
async function processPlaylistTrack(track, index, audioBitrate, audioFormat, ffmpegFormat) {
    const tempFiles = [];

    try {
        Logger.info(`[Track ${index + 1}] Processing: ${track.title} - ${track.artist}`);

        let downloadTarget;
        if (track.url) {
            downloadTarget = track.url;
        } else {
            const cleanArtist = track.artist.replace(/,/g, ' ');
            downloadTarget = `ytsearch1:${track.title} ${cleanArtist}`;
        }

        const downloadPromises = [downloadToTemp(downloadTarget, 'webm')];
        let tempImgPath = '';

        if (track.thumbnail) {
            downloadPromises.push(
                axios.get(track.thumbnail, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 })
                    .then(imgRes => {
                        if (imgRes.status === 200) {
                            tempImgPath = path.join(os.tmpdir(), `cover_zip_${Date.now()}_${index}.jpg`);
                            fs.writeFileSync(tempImgPath, Buffer.from(imgRes.data));
                            tempFiles.push(tempImgPath);
                        }
                    }).catch(() => {})
            );
        }

        const results = await Promise.all(downloadPromises);
        const tempAudioPath = results[0];
        tempFiles.push(tempAudioPath);

        const tempOutPath = path.join(os.tmpdir(), `track_${Date.now()}_${index}.${audioFormat}`);
        tempFiles.push(tempOutPath);

        await new Promise((resolve, reject) => {
            const ff = ffmpeg(tempAudioPath);
            const outOpts = ['-map', '0:a:0'];

            if (audioFormat === 'mp3') outOpts.push('-c:a', 'libmp3lame');
            else if (audioFormat === 'm4a') outOpts.push('-c:a', 'aac');
            else if (audioFormat === 'ogg') outOpts.push('-c:a', 'libvorbis');
            else if (audioFormat === 'wav') outOpts.push('-c:a', 'pcm_s16le');
            else if (audioFormat === 'flac') outOpts.push('-c:a', 'flac');

            const ffTimeout = setTimeout(() => {
                ff.kill('SIGKILL');
                reject(new Error('Track encoding timed out.'));
            }, 60000);

            ff.outputOptions(outOpts)
              .audioBitrate(audioBitrate)
              .format(ffmpegFormat)
              .save(tempOutPath)
              .on('error', (err) => { clearTimeout(ffTimeout); reject(err); })
              .on('end', () => { clearTimeout(ffTimeout); resolve(); });
        });

        // tag each mp3 in the playlist with cover art and metadata
        if (tempImgPath && fs.existsSync(tempOutPath)) {
            if (audioFormat === 'mp3') {
                try {
                    const tags = { title: track.title, artist: track.artist };
                    tags.image = {
                        mime: 'image/jpeg',
                        type: { id: 3, name: 'front cover' },
                        description: 'Cover Art',
                        imageBuffer: fs.readFileSync(tempImgPath)
                    };
                    const updated = NodeID3.write(tags, fs.readFileSync(tempOutPath));
                    fs.writeFileSync(tempOutPath, updated);
                } catch (e) {}
            }
        }

        const buffer = fs.readFileSync(tempOutPath);
        const safeName = sanitizeFilename(`${String(index + 1).padStart(2, '0')} - ${track.title} - ${track.artist}.${audioFormat}`);

        cleanupFiles(tempFiles);
        return { name: safeName, buffer };

    } catch (err) {
        Logger.error(`[Track ${index + 1}] FAILED: ${track.title} - ${err.message}`);
        cleanupFiles(tempFiles);
        return null;
    }
}

// worker function that processes the actual download request
async function executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res) {
    try {
        Logger.info(`Task started: ${url} (${audioFormat.toUpperCase()})`);

        const mimeTypes = {
            mp3: 'audio/mpeg',
            m4a: 'audio/mp4',
            ogg: 'audio/ogg',
            wav: 'audio/wav',
            flac: 'audio/flac'
        };
        const mimeType = mimeTypes[audioFormat] || 'audio/mpeg';
        const asciiFilename = sanitizeAsciiHeader(safeFilename);
        const ffmpegFormatMap = { mp3: 'mp3', m4a: 'ipod', ogg: 'ogg', wav: 'wav', flac: 'flac' };
        const ffmpegFormat = ffmpegFormatMap[audioFormat] || 'mp3';

        // download a single youtube video
        if (isYouTubeUrl(url) && !isYouTubePlaylist(url)) {
            res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}.${audioFormat}"`);
            res.setHeader('Content-Type', mimeType);
            const info = await getYoutubeInfo(url);
            await processAndStreamAudio(url, audioBitrate, audioFormat, info.thumbnail, res, info.title, info.author);
            return;
        }

        // download a single spotify track
        if (url.includes('spotify.com/track/')) {
            res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}.${audioFormat}"`);
            res.setHeader('Content-Type', mimeType);
            const spotifyData = await getSpotifyData(url);
            const track = spotifyData.tracks[0];
            const cleanArtist = track.artist.replace(/,/g, ' ');
            const searchQuery = `ytsearch1:${track.title} ${cleanArtist}`;
            await processAndStreamAudio(searchQuery, audioBitrate, audioFormat, track.thumbnail, res, track.title, track.artist);
            return;
        }

        // download full playlists or albums as a zip
        let collectionData = null;
        if (isYouTubePlaylist(url)) {
            Logger.info('Fetching YouTube playlist items');
            collectionData = await getYoutubePlaylistData(url);
        } else if (url.includes('spotify.com/album/') || url.includes('spotify.com/playlist/')) {
            Logger.info('Fetching Spotify collection items');
            collectionData = await getSpotifyData(url);
        }

        if (collectionData && collectionData.tracks && collectionData.tracks.length > 0) {
            const zipName = sanitizeAsciiHeader(`${collectionData.name}.zip`);
            res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
            res.setHeader('Content-Type', 'application/zip');

            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(res);

            archive.on('warning', (err) => Logger.warn(`ZIP archive warning: ${err.message}`));
            archive.on('error', (err) => {
                Logger.error(`ZIP archive error: ${err.message}`);
                if (!res.headersSent) res.status(500).end();
            });

            // convert songs a few at a time so we do not run out of memory
            const batchSize = 3;
            const tracks = collectionData.tracks;

            for (let i = 0; i < tracks.length; i += batchSize) {
                const batch = tracks.slice(i, i + batchSize);
                Logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(tracks.length / batchSize)}`);

                const results = await Promise.all(
                    batch.map((track, j) => processPlaylistTrack(track, i + j, audioBitrate, audioFormat, ffmpegFormat))
                );

                results.forEach(result => {
                    if (result && result.buffer) {
                        archive.append(result.buffer, { name: result.name });
                    }
                });
            }

            archive.finalize();
            Logger.success(`Archive completed: ${zipName}`);
            return;
        }

        if (!res.headersSent) {
            res.status(400).json({ error: 'Unsupported or unreadable URL format.' });
        }

    } catch (error) {
        Logger.error(`Queue execution error: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'Error occurred while processing download.' });
        }
    }
}

// health check route so uptime monitors know the server is running
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        app: 'Ripcord',
        ytdlp: ytdlpAvailable ? ytdlpVersion : 'unavailable',
        queue: {
            running: downloadQueue.running,
            pending: downloadQueue.queue.length
        }
    });
});

// inspect a link and return title, artist, and cover art
app.get('/api/fetch-info', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url || !isSafeUrl(url)) {
            return res.status(400).json({ error: 'Please enter a valid Spotify or YouTube URL.' });
        }

        Logger.info(`Metadata requested for: ${url}`);

        if (isYouTubePlaylist(url)) {
            const ytData = await getYoutubePlaylistData(url);
            return res.json({
                type: 'collection',
                title: ytData.name,
                trackCount: ytData.tracks.length,
                thumbnail: ytData.tracks[0]?.thumbnail || ''
            });
        } else if (isYouTubeUrl(url)) {
            const info = await getYoutubeInfo(url);
            return res.json({
                type: 'track',
                title: info.title,
                artist: info.author,
                thumbnail: info.thumbnail
            });
        } else if (url.includes('spotify.com/track/')) {
            const spotifyData = await getSpotifyData(url);
            const track = spotifyData.tracks[0];
            return res.json({
                type: 'track',
                title: track.title,
                artist: track.artist,
                thumbnail: track.thumbnail
            });
        } else if (url.includes('spotify.com/album/') || url.includes('spotify.com/playlist/')) {
            const spotifyData = await getSpotifyData(url);
            return res.json({
                type: 'collection',
                title: spotifyData.name,
                trackCount: spotifyData.tracks.length,
                thumbnail: spotifyData.thumbnail
            });
        } else {
            return res.status(400).json({ error: 'Unsupported URL. Please provide a Spotify or YouTube link.' });
        }
    } catch (error) {
        Logger.error(`Fetch info error: ${error.message}`);
        res.status(500).json({ error: error.message || 'Failed to inspect link.' });
    }
});

// api endpoint to start downloading the audio
app.get('/api/download', (req, res) => {
    const { url, bitrate, filename, format } = req.query;
    const audioBitrate = parseInt(bitrate, 10) || 128;
    const audioFormat = (format || 'mp3').toLowerCase();
    const safeFilename = sanitizeFilename(filename);

    if (!url || !isSafeUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL provided.' });
    }

    downloadQueue.addTask(() => executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res));
});

// image proxy so the frontend can read album cover pixels without cors errors
const COVER_HOSTS = ['ytimg.com', 'spotifycdn.com', 'scdn.co'];

app.get('/api/cover', async (req, res) => {
    let target;
    try {
        target = new URL(String(req.query.url || ''));
    } catch {
        return res.status(400).json({ error: 'Invalid image URL.' });
    }
    const allowed = target.protocol === 'https:' &&
        COVER_HOSTS.some(h => target.hostname === h || target.hostname.endsWith('.' + h));
    if (!allowed) {
        return res.status(400).json({ error: 'Image host not allowed.' });
    }

    try {
        const upstream = await axios.get(target.href, {
            responseType: 'stream',
            timeout: 6000,
            maxRedirects: 0,
            maxContentLength: 5 * 1024 * 1024,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const type = String(upstream.headers['content-type'] || '');
        if (!type.startsWith('image/')) {
            upstream.data.destroy();
            return res.status(502).json({ error: 'Not an image.' });
        }
        res.set('Content-Type', type);
        res.set('Cache-Control', 'public, max-age=86400');
        upstream.data.pipe(res);
    } catch {
        res.status(502).json({ error: 'Could not load image.' });
    }
});

// send index.html for any other route
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// this is a function to start the server.
const PORT = parseInt(process.env.PORT, 10) || 5224;

app.listen(PORT, '0.0.0.0', () => {
    Logger.success(`Ripcord server live at http://localhost:${PORT}`);
    Logger.info('Ready for requests under domain (e.g. webjuniors.org)');
});
