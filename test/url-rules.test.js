const assert = require('assert');
const { normalizeYouTubeUrl, isYouTubePlaylist } = require('../server');

const cases = [
    {
        name: 'youtube.com/watch with list=PL... param',
        input: 'https://www.youtube.com/watch?v=biYdUZXfz9I&list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz',
        expectedType: 'single',
        expectedNormalizedMatch: /watch\?v=biYdUZXfz9I$/,
        forbiddenParams: ['list', 'index', 'start_radio', 'pp']
    },
    {
        name: 'youtube.com/watch with list=RD... radio param',
        input: 'https://www.youtube.com/watch?v=biYdUZXfz9I&list=RDbiYdUZXfz9I',
        expectedType: 'single',
        expectedNormalizedMatch: /watch\?v=biYdUZXfz9I$/,
        forbiddenParams: ['list', 'index', 'start_radio', 'pp']
    },
    {
        name: 'youtu.be/ID with list=PL... param',
        input: 'https://youtu.be/biYdUZXfz9I?list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz',
        expectedType: 'single',
        expectedNormalizedMatch: /youtu\.be\/biYdUZXfz9I$/,
        forbiddenParams: ['list', 'index', 'start_radio', 'pp']
    },
    {
        name: 'music.youtube.com/watch with list=PL... param',
        input: 'https://music.youtube.com/watch?v=biYdUZXfz9I&list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz',
        expectedType: 'single',
        expectedNormalizedMatch: /watch\?v=biYdUZXfz9I$/,
        forbiddenParams: ['list', 'index', 'start_radio', 'pp']
    },
    {
        name: 'youtube.com/playlist with list=PL... param',
        input: 'https://www.youtube.com/playlist?list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz',
        expectedType: 'collection',
        expectedNormalizedMatch: /playlist\?list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz$/,
        mustContainParam: 'list'
    },
    {
        name: 'youtube.com/playlist with list=RD<11-char-id> radio param',
        input: 'https://www.youtube.com/playlist?list=RDbiYdUZXfz9I',
        expectedType: 'single',
        expectedNormalizedMatch: /watch\?v=biYdUZXfz9I$/,
        forbiddenParams: ['list', 'index', 'start_radio', 'pp']
    },
    {
        name: 'youtube.com/watch with list=PL... param but no v parameter',
        input: 'https://www.youtube.com/watch?list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz',
        expectedType: 'collection',
        expectedNormalizedMatch: /watch\?list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz$/,
        mustContainParam: 'list'
    }
];

let failed = 0;
console.log('Testing YouTube URL rules:');

for (const tc of cases) {
    const isPlaylist = isYouTubePlaylist(tc.input);
    const normalized = normalizeYouTubeUrl(tc.input);
    const type = isPlaylist ? 'collection' : 'single';

    console.log(`\n• ${tc.name}`);
    console.log(`  Input:      ${tc.input}`);
    console.log(`  Type:       ${type} (expected: ${tc.expectedType})`);
    console.log(`  Normalized: ${normalized}`);

    try {
        assert.strictEqual(type, tc.expectedType, `Type mismatch for ${tc.name}`);
        assert.ok(tc.expectedNormalizedMatch.test(normalized), `Normalized URL mismatch: ${normalized}`);

        const parsedNorm = new URL(normalized);
        if (tc.forbiddenParams) {
            for (const param of tc.forbiddenParams) {
                assert.strictEqual(parsedNorm.searchParams.has(param), false, `Forbidden param "${param}" present in ${normalized}`);
            }
        }
        if (tc.mustContainParam) {
            assert.ok(parsedNorm.searchParams.has(tc.mustContainParam), `Expected param "${tc.mustContainParam}" in ${normalized}`);
        }
        console.log(`  PASS`);
    } catch (err) {
        console.error(`  FAIL: ${err.message}`);
        failed++;
    }
}

// Also test tolerating inputs without protocol
console.log('\nTesting protocol-less inputs:');
const noProto = 'youtube.com/watch?v=biYdUZXfz9I&list=PLIUe6H7w-fv5BFWPim7uvQz6iSQDxRTHz';
assert.strictEqual(isYouTubePlaylist(noProto), false);
const normNoProto = normalizeYouTubeUrl(noProto);
assert.ok(normNoProto.includes('watch?v=biYdUZXfz9I') && !normNoProto.includes('list='));
console.log(`  PASS: ${noProto} -> ${normNoProto}`);

if (failed > 0) {
    console.error(`\n${failed} test(s) failed!`);
    process.exit(1);
} else {
    console.log(`\nAll ${cases.length + 1} URL tests passed successfully!`);
}
