require('dotenv').config();
process.umask(0o077);
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { spawn, spawnSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const NodeID3 = require('node-id3');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

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
        const safeMessage = String(msg).replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 2000);
        const colors = {
            INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m'
        };
        return `${colors[level] || ''}[${time}] [${level}]${colors.RESET} ${safeMessage}`;
    },
    info: (msg) => console.log(Logger._format('INFO', msg)),
    success: (msg) => console.log(Logger._format('SUCCESS', msg)),
    warn: (msg) => console.log(Logger._format('WARN', msg)),
    error: (msg) => console.error(Logger._format('ERROR', msg))
};

Logger.info('Ripcord audio engine initializing');
Logger.info(`yt-dlp version: ${ytdlpVersion}`);
Logger.info(`ffmpeg path: ${ffmpegPath}`);

function positiveIntegerEnv(name, fallback, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(`${name} must be an integer between 1 and ${max}.`);
    }
    return value;
}

const RATE_LIMIT_WINDOW_MS = positiveIntegerEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 24 * 60 * 60 * 1000);
const API_RATE_LIMIT_MAX = positiveIntegerEnv('RATE_LIMIT_MAX', 120, 10000);
const INFO_RATE_LIMIT_MAX = positiveIntegerEnv('FETCH_INFO_RATE_LIMIT_MAX', 30, 1000);
const DOWNLOAD_RATE_LIMIT_MAX = positiveIntegerEnv('DOWNLOAD_RATE_LIMIT_MAX', 8, 1000);
const COVER_RATE_LIMIT_MAX = positiveIntegerEnv('COVER_RATE_LIMIT_MAX', 120, 5000);
const DOWNLOAD_CONCURRENCY = positiveIntegerEnv('DOWNLOAD_CONCURRENCY', 2, 4);
const METADATA_CONCURRENCY = positiveIntegerEnv('METADATA_CONCURRENCY', 2, 8);
const MAX_QUEUED_DOWNLOADS = positiveIntegerEnv('MAX_QUEUED_DOWNLOADS', 8, 100);
const MAX_PLAYLIST_TRACKS = 30;
const MAX_PLAYLIST_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_OUTPUT_BYTES = 150 * 1024 * 1024;
const MAX_ZIP_TRACK_BYTES = 40 * 1024 * 1024;
const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS === undefined
    ? false
    : positiveIntegerEnv('TRUST_PROXY_HOPS', 1, 5);

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
    constructor(concurrency = DOWNLOAD_CONCURRENCY, maxQueued = MAX_QUEUED_DOWNLOADS) {
        this.concurrency = concurrency;
        this.maxQueued = maxQueued;
        this.running = 0;
        this.queue = [];
    }

    addTask(task, res) {
        if (this.running >= this.concurrency && this.queue.length >= this.maxQueued) return false;

        const entry = { task, res, controller: new AbortController(), started: false };
        entry.onClose = () => {
            if (res.writableEnded) return;
            entry.controller.abort();
            if (!entry.started) this.queue = this.queue.filter(queued => queued !== entry);
        };
        res.once('close', entry.onClose);
        this.queue.push(entry);
        Logger.info(`[Queue] Task queued. Position: ${this.queue.length}. Running: ${this.running}/${this.concurrency}`);
        this.process();
        return true;
    }

    process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const entry = this.queue.shift();
        entry.started = true;

        if (entry.controller.signal.aborted || entry.res.destroyed) {
            entry.res.removeListener('close', entry.onClose);
            this.running--;
            this.process();
            return;
        }

        Promise.resolve(entry.task(entry.controller.signal))
            .catch(err => Logger.error(`[Queue] Task failed: ${err.message}`))
            .finally(() => {
                entry.res.removeListener('close', entry.onClose);
                this.running--;
                this.process();
            });
    }
}

// small semaphore so playlist metadata lookups do not spawn without a global limit
class MetadataSemaphore {
    constructor(concurrency = METADATA_CONCURRENCY, maxQueued = MAX_QUEUED_DOWNLOADS) {
        this.concurrency = concurrency;
        this.maxQueued = maxQueued;
        this.running = 0;
        this.queue = [];
    }

    tryAcquire() {
        if (this.running < this.concurrency) {
            this.running++;
            const acquisition = Promise.resolve(this.createRelease());
            acquisition.cancel = () => { };
            return acquisition;
        }
        if (this.queue.length >= this.maxQueued) return null;

        let resolveAcquisition;
        let rejectAcquisition;
        const acquisition = new Promise((resolve, reject) => {
            resolveAcquisition = resolve;
            rejectAcquisition = reject;
        });
        const waiter = { resolve: resolveAcquisition, reject: rejectAcquisition, cancelled: false };
        acquisition.cancel = () => {
            if (waiter.cancelled) return;
            waiter.cancelled = true;
            this.queue = this.queue.filter(queued => queued !== waiter);
            waiter.reject(new Error('Metadata request cancelled.'));
        };
        this.queue.push(waiter);
        return acquisition;
    }

    createRelease() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.running--;
            while (this.queue.length > 0) {
                const waiter = this.queue.shift();
                if (waiter.cancelled) continue;
                this.running++;
                waiter.resolve(this.createRelease());
                break;
            }
        };
    }
}

const downloadQueue = new DownloadQueue();
const metadataSemaphore = new MetadataSemaphore();

// set up the express app
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            imgSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            upgradeInsecureRequests: null
        }
    }
}));

function createRateLimiter(limit, message) {
    return rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res) => res.status(429).json({ error: message })
    });
}

app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use('/api', createRateLimiter(API_RATE_LIMIT_MAX, 'Too many API requests. Please wait before trying again.'));
app.use('/api/fetch-info', createRateLimiter(INFO_RATE_LIMIT_MAX, 'Too many metadata requests. Please wait before trying again.'));
app.use('/api/download', createRateLimiter(DOWNLOAD_RATE_LIMIT_MAX, 'Too many download requests. Please wait before trying again.'));
app.use('/api/cover', createRateLimiter(COVER_RATE_LIMIT_MAX, 'Too many cover requests. Please wait before trying again.'));

function rejectCrossSiteRequests(req, res, next) {
    if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
        return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    }

    const origin = req.get('origin');
    const requestHost = req.get('host');
    if (origin && requestHost) {
        try {
            const originUrl = new URL(origin);
            const hostUrl = new URL(`http://${requestHost}`);
            if (originUrl.hostname.toLowerCase() !== hostUrl.hostname.toLowerCase()) {
                return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
            }
        } catch (e) {
            // Ignore malformed origin or host headers and preserve non-browser client compatibility.
        }
    }
    next();
}

// serve static files only after every API path has passed common protections
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const SPOTIFY_HOSTS = new Set(['open.spotify.com']);

// Only accept canonical provider links, never arbitrary hosts that merely contain a provider name.
function isSafeUrl(urlString) {
    if (typeof urlString !== 'string' || urlString.length === 0 || urlString.length > 2048) return false;

    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;

        const host = parsed.hostname.toLowerCase();
        if (YOUTUBE_HOSTS.has(host)) {
            if (host === 'youtu.be') return /^\/[A-Za-z0-9_-]{11}\/?$/.test(parsed.pathname);
            return /^\/(?:watch|playlist|shorts\/[A-Za-z0-9_-]{11}|embed\/[A-Za-z0-9_-]{11}|live\/[A-Za-z0-9_-]{11})\/?$/.test(parsed.pathname);
        }

        return SPOTIFY_HOSTS.has(host) && /^\/(?:track|album|playlist)\/[A-Za-z0-9]+\/?$/.test(parsed.pathname);
    } catch (e) {
        return false;
    }
}

function parseCoverUrl(urlString) {
    if (typeof urlString !== 'string' || urlString.length === 0 || urlString.length > 2048) return null;
    try {
        const parsed = new URL(urlString);
        const host = parsed.hostname.toLowerCase();
        const allowed = ['ytimg.com', 'spotifycdn.com', 'scdn.co']
            .some(domain => host === domain || host.endsWith(`.${domain}`));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowed) return null;
        return parsed;
    } catch (e) {
        return null;
    }
}

function spotifyLinkDetails(urlString) {
    if (!isSafeUrl(urlString)) return null;
    const parsed = new URL(urlString);
    const match = parsed.pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]+)\/?$/);
    return match ? { type: match[1], id: match[2] } : null;
}

function safeMetadataText(value, fallback = '') {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return text.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || fallback;
}

// clean up filenames so they do not break the filesystem
function sanitizeFilename(name) {
    if (typeof name !== 'string' || !name) return 'audio_track';
    return name.slice(0, 240).replace(/<[^>]*>|&nbsp;|&[a-z]+;|[\$`'";|&]|\.\.[/\\]|[\x00-\x1F\x7F]/g, '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/^\.+/, '')
        .replace(/\s+/g, ' ')
        .trim().slice(0, 120) || 'audio_track';
}

function sanitizeAsciiHeader(name) {
    const ascii = String(name || '').replace(/[^\x20-\x7E]/g, '').replace(/["\\;]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
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
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        let id = null;
        if (host === 'youtu.be') id = parsed.pathname.slice(1);
        else if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
        else id = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    } catch (e) {
        return null;
    }
}

function isYouTubeUrl(url) {
    try {
        const parsed = new URL(url);
        return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
    } catch (e) {
        return false;
    }
}

function isYouTubePlaylist(url) {
    try {
        const parsed = new URL(url);
        return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase()) && (parsed.pathname === '/playlist' || parsed.searchParams.has('list'));
    } catch (e) {
        return false;
    }
}

// fetch youtube video info using oembed first
async function getYoutubeInfo(url, signal) {
    const videoId = getYouTubeVideoId(url);
    const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '';
    let title = 'Unknown Title';
    let author = 'Unknown Channel';

    if (videoId) {
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const response = await axios.get(oembedUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 5000,
                maxRedirects: 0,
                maxContentLength: 1024 * 1024,
                signal
            });
            if (response.status === 200 && response.data) {
                title = safeMetadataText(response.data.title, title);
                author = safeMetadataText(response.data.author_name, author);
            }
        } catch (error) {
            Logger.warn(`YouTube oEmbed warning for ${videoId}: ${error.message}`);
        }
    }
    return { title, author, thumbnail };
}

// list all songs in a youtube playlist without downloading them yet
async function getYoutubePlaylistData(url, signal) {
    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '--flat-playlist',
            '--print', '%(playlist_title)s:::%(id)s:::%(title)s:::%(uploader)s',
            '--ignore-errors',
            '--no-abort-on-error',
            '--no-warnings',
            '--playlist-end', String(MAX_PLAYLIST_TRACKS)
        ];

        if (COOKIES_PATH) {
            ytdlpArgs.push('--cookies', COOKIES_PATH);
        }

        ytdlpArgs.push('--', url);

        const ytdlp = spawn('yt-dlp', ytdlpArgs);
        let output = '';
        let timedOut = false;

        const timeout = setTimeout(() => {
            timedOut = true;
            ytdlp.kill('SIGKILL');
        }, 30000);
        const onAbort = () => ytdlp.kill('SIGKILL');
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });

        let outputBytes = 0;
        ytdlp.stdout.on('data', (data) => {
            outputBytes += data.length;
            if (outputBytes > MAX_PLAYLIST_OUTPUT_BYTES) {
                ytdlp.kill('SIGKILL');
                return;
            }
            output += data.toString();
        });
        ytdlp.stderr.on('data', (data) => Logger.warn(`yt-dlp playlist stderr: ${data.toString().trim()}`));

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                reject(new Error('Request cancelled.'));
            } else if (timedOut) {
                reject(new Error('Playlist metadata fetch timed out.'));
            } else if (outputBytes > MAX_PLAYLIST_OUTPUT_BYTES) {
                reject(new Error('Playlist metadata exceeds the allowed size.'));
            } else if (code === 0 || output.length > 0) {
                const lines = output.trim().split('\n').filter(Boolean);
                let playlistName = 'YouTube Playlist';

                const tracks = lines.map((line, index) => {
                    const parts = line.split(':::');
                    const pName = parts[0];
                    const id = parts[1];

                    if (index === 0 && pName && pName !== 'NA') {
                        playlistName = safeMetadataText(pName, playlistName);
                    }

                    if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) return null;

                    return {
                        title: safeMetadataText(parts[2], 'Unknown Track'),
                        artist: safeMetadataText(parts[3], 'Unknown Artist'),
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
            signal?.removeEventListener('abort', onAbort);
            reject(err);
        });
    });
}

// grab song or playlist info by reading the spotify embed page
async function getSpotifyData(url, signal) {
    const link = spotifyLinkDetails(url);
    if (!link) throw new Error('Invalid Spotify link.');

    const { type, id } = link;

    let coverImage = '';
    let collectionName = 'Spotify Collection';

    try {
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const oembedRes = await axios.get(oembedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 5000,
            maxRedirects: 0,
            maxContentLength: 1024 * 1024,
            signal
        });
        if (oembedRes.status === 200 && oembedRes.data) {
            coverImage = parseCoverUrl(oembedRes.data.thumbnail_url)?.href || '';
            collectionName = safeMetadataText(oembedRes.data.title, collectionName);
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
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
        signal
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
                    title: safeMetadataText(entity?.name, 'Unknown Track'),
                    artist: safeMetadataText(artistName, 'Unknown Artist'),
                    thumbnail: coverImage
                });
            } else {
                const rawTracks = findTracks(data)?.slice(0, MAX_PLAYLIST_TRACKS);
                if (rawTracks && rawTracks.length > 0) {
                    rawTracks.forEach(t => {
                        const trackData = t.track || t;
                        const title = safeMetadataText(trackData.title || trackData.name, 'Unknown Track');
                        let trackArtists = 'Unknown Artist';
                        if (trackData.artists && Array.isArray(trackData.artists)) {
                            trackArtists = safeMetadataText(trackData.artists.map(a => (typeof a === 'string' ? a : a.name)).join(', '), 'Unknown Artist');
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
        if (imageMatch && !coverImage) coverImage = parseCoverUrl(imageMatch[1])?.href || '';

        // spotify titles usually look like Title · Artist
        if (parsedTitle.includes(' · ')) {
            const parts = parsedTitle.split(' · ');
            parsedTitle = parts[0];
            parsedArtist = parts[1];
        }

        tracks.push({
            title: safeMetadataText(parsedTitle.replace(/ - song and lyrics by.*$/i, ''), 'Unknown Track'),
            artist: safeMetadataText(parsedArtist.replace(/Listen to.*on Spotify.*$/i, ''), 'Unknown Artist'),
            thumbnail: coverImage
        });
    }

    if (tracks.length === 0) {
        throw new Error('Unable to extract Spotify metadata. The track/playlist may be private or restricted.');
    }

    return { type, name: collectionName, tracks, thumbnail: coverImage };
}

// download the raw audio stream to a temp file using yt-dlp
async function downloadToTemp(targetUrl, extension = 'webm', signal) {
    const tempPath = path.join(os.tmpdir(), `ripcord_${randomUUID()}.${extension}`);

    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '-f', 'bestaudio/best',
            '--no-playlist',
            '--no-warnings',
            '--max-filesize', `${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))}M`,
            '--extractor-args', 'youtube:player_client=android,web'
        ];

        if (COOKIES_PATH) {
            ytdlpArgs.push('--cookies', COOKIES_PATH);
        }

        ytdlpArgs.push('-o', tempPath, '--', targetUrl);

        const ytdlp = spawn('yt-dlp', ytdlpArgs);
        let timedOut = false;

        const timeout = setTimeout(() => {
            timedOut = true;
            ytdlp.kill('SIGKILL');
        }, 90000);
        const onAbort = () => ytdlp.kill('SIGKILL');
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });

        ytdlp.stderr.on('data', (data) => Logger.warn(`yt-dlp: ${data.toString().trim()}`));

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                cleanupFiles([tempPath]);
                reject(new Error('Request cancelled.'));
            } else if (timedOut) {
                cleanupFiles([tempPath]);
                reject(new Error('Audio download timed out.'));
            } else if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size <= MAX_DOWNLOAD_BYTES) {
                resolve(tempPath);
            } else {
                cleanupFiles([tempPath]);
                reject(new Error('yt-dlp was unable to extract this audio source.'));
            }
        });

        ytdlp.on('error', (err) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            cleanupFiles([tempPath]);
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

            const readResult = spawnSync('vorbiscomment', ['-l', '-R', filePath], { timeout: 15000, windowsHide: true });
            if (readResult.error || readResult.status !== 0) return false;

            let comments = readResult.stdout.toString().split('\n');
            comments = comments.filter(c => c && !c.startsWith('metadata_block_picture='));
            comments.push(`metadata_block_picture=${base64Block}`);

            const tempCommentsFile = path.join(os.tmpdir(), `comments_${randomUUID()}.txt`);
            fs.writeFileSync(tempCommentsFile, comments.join('\n'));
            try {
                const writeResult = spawnSync('vorbiscomment', ['-w', '-R', '-c', tempCommentsFile, filePath], { timeout: 15000, windowsHide: true });
                return !writeResult.error && writeResult.status === 0;
            } finally {
                cleanupFiles([tempCommentsFile]);
            }
        } catch (e) {
            return false;
        }
    } else if (format === 'flac') {
        try {
            spawnSync('metaflac', ['--remove', '--block-type=PICTURE', '--except-block-type=STREAMINFO', filePath], { timeout: 15000, windowsHide: true });
            const spec = `3||Front Cover||${imgPath}`;
            const writeResult = spawnSync('metaflac', [`--import-picture-from=${spec}`, filePath], { timeout: 15000, windowsHide: true });
            return !writeResult.error && writeResult.status === 0;
        } catch (e) {
            return false;
        }
    }
    return false;
}

// transcode the audio with ffmpeg and stream it directly to the user
async function processAndStreamAudio(target, bitrate, format, thumbnailUrl, res, filename = '', artist = '', signal) {
    const tempFiles = [];

    // clean up temp files if the user closes their browser or cancels
    const onDisconnect = () => cleanupFiles(tempFiles);
    res.on('close', onDisconnect);

    try {
        Logger.info('Downloading validated audio source');
        const tempAudioPath = await downloadToTemp(target, 'webm', signal);
        tempFiles.push(tempAudioPath);

        let tempImgPath = '';
        const safeThumbnail = parseCoverUrl(thumbnailUrl);
        if (safeThumbnail) {
            try {
                const imgRes = await axios.get(safeThumbnail.href, {
                    responseType: 'arraybuffer',
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 6000,
                    maxRedirects: 0,
                    maxContentLength: MAX_COVER_BYTES,
                    signal
                });
                if (imgRes.status === 200 && String(imgRes.headers['content-type'] || '').toLowerCase().startsWith('image/jpeg')) {
                    tempImgPath = path.join(os.tmpdir(), `cover_${randomUUID()}.img`);
                    fs.writeFileSync(tempImgPath, Buffer.from(imgRes.data));
                    tempFiles.push(tempImgPath);
                }
            } catch (imgErr) {
                Logger.warn(`Cover art fetch omitted: ${imgErr.message}`);
            }
        }

        const tempOutPath = path.join(os.tmpdir(), `out_${randomUUID()}.${format}`);
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
            opts.push('-fs', String(MAX_AUDIO_OUTPUT_BYTES));

            const ffTimeout = setTimeout(() => {
                ff.kill('SIGKILL');
                reject(new Error('Audio encoding timed out.'));
            }, 60000);
            const onAbort = () => ff.kill('SIGKILL');
            if (signal?.aborted) {
                clearTimeout(ffTimeout);
                reject(new Error('Request cancelled.'));
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });

            ff.outputOptions(opts)
                .audioBitrate(bitrate)
                .format(ffmpegFormat)
                .save(tempOutPath)
                .on('error', (err) => { clearTimeout(ffTimeout); signal?.removeEventListener('abort', onAbort); reject(err); })
                .on('end', () => { clearTimeout(ffTimeout); signal?.removeEventListener('abort', onAbort); resolve(); });
        });
            if (signal?.aborted) throw new Error('Request cancelled.');
            if (fs.statSync(tempOutPath).size >= MAX_AUDIO_OUTPUT_BYTES) throw new Error('Audio output exceeds the allowed size.');

        // attach the cover image to the converted audio
        if (tempImgPath && fs.existsSync(tempOutPath)) {
            if (format === 'm4a' || format === 'wav') {
                const taggedPath = path.join(os.tmpdir(), `tagged_${randomUUID()}.${format}`);
                tempFiles.push(taggedPath);
                try {
                    let args = [];
                    if (format === 'wav') {
                        args = ['-y', '-i', tempOutPath, '-i', tempImgPath, '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'mjpeg', '-id3v2_version', '3', '-metadata:s:v', 'title=Album cover', taggedPath];
                    } else if (format === 'm4a') {
                        args = ['-y', '-i', tempOutPath, '-i', tempImgPath, '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', taggedPath];
                    }
                    if (args.length) {
                        const tagResult = spawnSync('ffmpeg', args, { stdio: 'ignore', timeout: 30000, windowsHide: true });
                        if (tagResult.error || tagResult.status !== 0) throw new Error('Unable to embed cover art.');
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
        if (fileStat.size > MAX_AUDIO_OUTPUT_BYTES) throw new Error('Audio output exceeds the allowed size.');
        res.setHeader('Content-Length', fileStat.size);

        const readStream = fs.createReadStream(tempOutPath);
        readStream.pipe(res);
        readStream.on('error', () => res.destroy());

        readStream.on('end', () => {
            res.removeListener('close', onDisconnect);
            cleanupFiles(tempFiles);
        });

    } catch (error) {
        Logger.error(`Audio processing error: ${error.message}`);
        res.removeListener('close', onDisconnect);
        cleanupFiles(tempFiles);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Unable to process this audio request.' });
        } else res.destroy();
    }
}

// convert one song so we can add it to the zip file
async function processPlaylistTrack(track, index, audioBitrate, audioFormat, ffmpegFormat, signal) {
    const tempFiles = [];

    try {
        const title = String(track.title || 'Unknown Track').slice(0, 200);
        const artist = String(track.artist || 'Unknown Artist').slice(0, 200);
        Logger.info(`[Track ${index + 1}] Processing: ${sanitizeAsciiHeader(`${title} - ${artist}`)}`);

        let downloadTarget;
        if (track.url) {
            if (!isSafeUrl(track.url)) throw new Error('Invalid playlist track URL.');
            downloadTarget = track.url;
        } else {
            const cleanArtist = artist.replace(/,/g, ' ');
            downloadTarget = `ytsearch1:${title} ${cleanArtist}`;
        }

        const downloadPromises = [downloadToTemp(downloadTarget, 'webm', signal)];
        let tempImgPath = '';
        const safeThumbnail = parseCoverUrl(track.thumbnail);

        if (safeThumbnail) {
            downloadPromises.push(
                axios.get(safeThumbnail.href, {
                    responseType: 'arraybuffer',
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 6000,
                    maxRedirects: 0,
                    maxContentLength: MAX_COVER_BYTES,
                    signal
                })
                    .then(imgRes => {
                        if (imgRes.status === 200 && String(imgRes.headers['content-type'] || '').toLowerCase().startsWith('image/jpeg')) {
                            tempImgPath = path.join(os.tmpdir(), `cover_zip_${randomUUID()}.img`);
                            fs.writeFileSync(tempImgPath, Buffer.from(imgRes.data));
                            tempFiles.push(tempImgPath);
                        }
                    }).catch(() => { })
            );
        }

        const results = await Promise.all(downloadPromises);
        const tempAudioPath = results[0];
        tempFiles.push(tempAudioPath);

        const tempOutPath = path.join(os.tmpdir(), `track_${randomUUID()}.${audioFormat}`);
        tempFiles.push(tempOutPath);

        await new Promise((resolve, reject) => {
            const ff = ffmpeg(tempAudioPath);
            const outOpts = ['-map', '0:a:0'];

            if (audioFormat === 'mp3') outOpts.push('-c:a', 'libmp3lame');
            else if (audioFormat === 'm4a') outOpts.push('-c:a', 'aac');
            else if (audioFormat === 'ogg') outOpts.push('-c:a', 'libvorbis');
            else if (audioFormat === 'wav') outOpts.push('-c:a', 'pcm_s16le');
            else if (audioFormat === 'flac') outOpts.push('-c:a', 'flac');
            outOpts.push('-fs', String(MAX_ZIP_TRACK_BYTES));

            const ffTimeout = setTimeout(() => {
                ff.kill('SIGKILL');
                reject(new Error('Track encoding timed out.'));
            }, 60000);

            const onAbort = () => ff.kill('SIGKILL');
            if (signal?.aborted) {
                clearTimeout(ffTimeout);
                reject(new Error('Request cancelled.'));
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });

            ff.outputOptions(outOpts)
                .audioBitrate(audioBitrate)
                .format(ffmpegFormat)
                .save(tempOutPath)
                .on('error', (err) => { clearTimeout(ffTimeout); signal?.removeEventListener('abort', onAbort); reject(err); })
                .on('end', () => { clearTimeout(ffTimeout); signal?.removeEventListener('abort', onAbort); resolve(); });
        });
        if (signal?.aborted) throw new Error('Request cancelled.');
        if (fs.statSync(tempOutPath).size >= MAX_ZIP_TRACK_BYTES) throw new Error('Playlist track exceeds the allowed size.');

        // tag each mp3 in the playlist with cover art and metadata
        if (tempImgPath && fs.existsSync(tempOutPath)) {
            if (audioFormat === 'mp3') {
                try {
                    const tags = { title, artist };
                    tags.image = {
                        mime: 'image/jpeg',
                        type: { id: 3, name: 'front cover' },
                        description: 'Cover Art',
                        imageBuffer: fs.readFileSync(tempImgPath)
                    };
                    const updated = NodeID3.write(tags, fs.readFileSync(tempOutPath));
                    fs.writeFileSync(tempOutPath, updated);
                } catch (e) { }
            }
        }

        if (fs.statSync(tempOutPath).size > MAX_ZIP_TRACK_BYTES) throw new Error('Playlist track exceeds the allowed size.');
        const safeName = sanitizeFilename(`${String(index + 1).padStart(2, '0')} - ${title} - ${artist}.${audioFormat}`);

        cleanupFiles(tempFiles.filter(file => file !== tempOutPath));
        return { name: safeName, filePath: tempOutPath };

    } catch (err) {
        Logger.error(`[Track ${index + 1}] FAILED: ${sanitizeAsciiHeader(String(track.title || 'Unknown Track'))} - ${err.message}`);
        cleanupFiles(tempFiles);
        return null;
    }
}

// worker function that processes the actual download request
async function executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res, signal) {
    try {
        Logger.info(`Task started (${audioFormat.toUpperCase()})`);
        if (signal.aborted) return;

        const spotifyLink = spotifyLinkDetails(url);

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
            const info = await getYoutubeInfo(url, signal);
            await processAndStreamAudio(url, audioBitrate, audioFormat, info.thumbnail, res, info.title, info.author, signal);
            return;
        }

        // download a single spotify track
        if (spotifyLink?.type === 'track') {
            res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}.${audioFormat}"`);
            res.setHeader('Content-Type', mimeType);
            const spotifyData = await getSpotifyData(url, signal);
            const track = spotifyData.tracks[0];
            const cleanArtist = track.artist.replace(/,/g, ' ');
            const searchQuery = `ytsearch1:${track.title} ${cleanArtist}`;
            await processAndStreamAudio(searchQuery, audioBitrate, audioFormat, track.thumbnail, res, track.title, track.artist, signal);
            return;
        }

        // download full playlists or albums as a zip
        let collectionData = null;
        if (isYouTubePlaylist(url)) {
            Logger.info('Fetching YouTube playlist items');
            collectionData = await getYoutubePlaylistData(url, signal);
        } else if (spotifyLink && spotifyLink.type !== 'track') {
            Logger.info('Fetching Spotify collection items');
            collectionData = await getSpotifyData(url, signal);
        }

        if (collectionData && collectionData.tracks && collectionData.tracks.length > 0) {
            const zipName = sanitizeAsciiHeader(`${collectionData.name}.zip`);
            res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
            res.setHeader('Content-Type', 'application/zip');

            const { ZipArchive } = await import('archiver');
            const archive = new ZipArchive({ zlib: { level: 6 } });
            archive.pipe(res);

            archive.on('warning', (err) => Logger.warn(`ZIP archive warning: ${err.message}`));
            const trackFilePaths = [];
            let trackFilesCleaned = false;
            const cleanupTrackFiles = () => {
                if (trackFilesCleaned) return;
                trackFilesCleaned = true;
                cleanupFiles(trackFilePaths);
            };
            archive.on('error', (err) => {
                Logger.error(`ZIP archive error: ${err.message}`);
                cleanupTrackFiles();
                if (!res.destroyed) res.destroy(err);
            });
            const onAbort = () => {
                try {
                    archive.abort();
                } finally {
                    cleanupTrackFiles();
                }
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });

            // convert songs a few at a time so we do not run out of memory
            const batchSize = 3;
            const tracks = collectionData.tracks.slice(0, MAX_PLAYLIST_TRACKS);
            let addedTracks = 0;

            try {
                for (let i = 0; i < tracks.length; i += batchSize) {
                    if (signal.aborted) throw new Error('Request cancelled.');
                    const batch = tracks.slice(i, i + batchSize);
                    Logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(tracks.length / batchSize)}`);

                    const results = await Promise.all(
                        batch.map((track, j) => processPlaylistTrack(track, i + j, audioBitrate, audioFormat, ffmpegFormat, signal))
                    );

                    results.forEach(result => {
                        if (result && result.filePath) {
                            trackFilePaths.push(result.filePath);
                            archive.file(result.filePath, { name: result.name });
                            addedTracks++;
                        }
                    });
                }

                if (addedTracks === 0) throw new Error('No tracks could be processed.');
                await archive.finalize();
                Logger.success(`Archive completed: ${zipName}`);
            } finally {
                signal.removeEventListener('abort', onAbort);
                cleanupTrackFiles();
            }
            return;
        }

        if (!res.headersSent) {
            res.status(400).json({ error: 'Unsupported or unreadable URL format.' });
        }

    } catch (error) {
        Logger.error(`Queue execution error: ${error.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Unable to complete this download request.' });
        } else if (!res.destroyed) res.destroy();
    }
}

// health check route so uptime monitors know the server is running
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// inspect a link and return title, artist, and cover art
app.get('/api/fetch-info', rejectCrossSiteRequests, async (req, res) => {
    try {
        const rawUrl = req.query.url;
        if (!isSafeUrl(rawUrl)) {
            return res.status(400).json({ error: 'Please enter a valid Spotify or YouTube URL.' });
        }
        const parsedUrl = new URL(rawUrl);
        parsedUrl.hash = '';
        const url = parsedUrl.href;
        const controller = new AbortController();
        let metadataAcquisition = null;
        res.once('close', () => {
            if (!res.writableEnded) {
                controller.abort();
                metadataAcquisition?.cancel();
            }
        });

        Logger.info(`Metadata requested from ${parsedUrl.hostname}`);

        if (isYouTubePlaylist(url)) {
            metadataAcquisition = metadataSemaphore.tryAcquire();
            if (!metadataAcquisition) {
                return res.status(503).json({ error: 'The metadata queue is full. Please try again shortly.' });
            }
            let release;
            try {
                release = await metadataAcquisition;
                if (controller.signal.aborted) return;
                const ytData = await getYoutubePlaylistData(url, controller.signal);
                return res.json({
                    type: 'collection',
                    title: ytData.name,
                    trackCount: ytData.tracks.length,
                    thumbnail: ytData.tracks[0]?.thumbnail || ''
                });
            } finally {
                release?.();
                metadataAcquisition.cancel();
            }
        } else if (isYouTubeUrl(url)) {
            const info = await getYoutubeInfo(url, controller.signal);
            return res.json({
                type: 'track',
                title: info.title,
                artist: info.author,
                thumbnail: info.thumbnail
            });
        } else if (spotifyLinkDetails(url)?.type === 'track') {
            const spotifyData = await getSpotifyData(url, controller.signal);
            const track = spotifyData.tracks[0];
            return res.json({
                type: 'track',
                title: track.title,
                artist: track.artist,
                thumbnail: track.thumbnail
            });
        } else if (spotifyLinkDetails(url)) {
            const spotifyData = await getSpotifyData(url, controller.signal);
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
        if (!res.destroyed && !res.headersSent) res.status(502).json({ error: 'Unable to inspect this media link.' });
    }
});

// api endpoint to start downloading the audio
app.get('/api/download', rejectCrossSiteRequests, (req, res) => {
    const rawUrl = req.query.url;
    const bitrate = req.query.bitrate;
    const filename = req.query.filename;
    const format = req.query.format;
        const audioBitrate = bitrate === undefined
            ? 128
            : typeof bitrate === 'string' && /^\d{2,3}$/.test(bitrate) ? Number(bitrate) : NaN;
    const audioFormat = format === undefined ? 'mp3' : format;

    if (!isSafeUrl(rawUrl)) {
        return res.status(400).json({ error: 'Invalid URL provided.' });
    }
    if (typeof audioFormat !== 'string' || !['mp3', 'm4a', 'flac', 'wav', 'ogg'].includes(audioFormat)) {
        return res.status(400).json({ error: 'Unsupported audio format.' });
    }
    if (typeof audioBitrate !== 'number' || ![128, 192, 320].includes(audioBitrate)) {
        return res.status(400).json({ error: 'Unsupported audio bitrate.' });
    }
    if (filename !== undefined && (typeof filename !== 'string' || filename.length > 120)) {
        return res.status(400).json({ error: 'Filename is invalid or too long.' });
    }

    const parsedUrl = new URL(rawUrl);
    parsedUrl.hash = '';
    const safeFilename = sanitizeFilename(filename);

    const accepted = downloadQueue.addTask(
        signal => executeDownloadTask(parsedUrl.href, audioBitrate, audioFormat, safeFilename, res, signal),
        res
    );
    if (!accepted) {
        return res.status(503).json({ error: 'The download queue is full. Please try again shortly.' });
    }
});

// image proxy so the frontend can read album cover pixels without cors errors
app.get('/api/cover', rejectCrossSiteRequests, async (req, res) => {
    const target = parseCoverUrl(req.query.url);
    if (!target) {
        return res.status(400).json({ error: 'Image host not allowed.' });
    }

    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
        const upstream = await axios.get(target.href, {
            responseType: 'stream',
            timeout: 6000,
            maxRedirects: 0,
            maxContentLength: MAX_COVER_BYTES,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal
        });
        const type = String(upstream.headers['content-type'] || '');
        const contentLength = Number(upstream.headers['content-length']);
        const contentType = type.split(';', 1)[0].trim().toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)
            || (Number.isFinite(contentLength) && contentLength > MAX_COVER_BYTES)) {
            upstream.data.destroy();
            return res.status(502).json({ error: 'Not an image.' });
        }
        let receivedBytes = 0;
        const sizeLimit = new Transform({
            transform(chunk, encoding, callback) {
                receivedBytes += chunk.length;
                if (receivedBytes > MAX_COVER_BYTES) callback(new Error('Cover image exceeds size limit.'));
                else callback(null, chunk);
            }
        });
        const streamError = () => {
            upstream.data.destroy();
            if (res.destroyed) return;
            if (res.headersSent) res.destroy();
            else res.status(502).json({ error: 'Could not load image.' });
        };
        upstream.data.on('error', streamError);
        sizeLimit.on('error', streamError);
        res.set('Content-Type', type.split(';', 1)[0]);
        res.set('Cache-Control', 'public, max-age=86400');
        upstream.data.pipe(sizeLimit).pipe(res);
    } catch {
        if (!res.destroyed && !res.headersSent) res.status(502).json({ error: 'Could not load image.' });
    }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

// send index.html for any other GET route
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
    Logger.error(`Unhandled request error: ${err.message}`);
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: 'Internal server error.' });
});

if (require.main === module) {
    const PORT = positiveIntegerEnv('PORT', 5224, 65535);
    const server = app.listen(PORT, '0.0.0.0', () => {
        Logger.success(`Ripcord server live at http://localhost:${PORT}`);
        Logger.info('Ready for requests under domain');
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
}

module.exports = { app, isSafeUrl, MetadataSemaphore };
