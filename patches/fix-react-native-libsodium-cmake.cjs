/**
 * Normalize Gradle's Windows node_modules path before CMake parses it. This is
 * harmless on Unix and keeps local Windows Android builds reproducible.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.join(repoRoot, 'packages/happy-app');
let cmakeFile;

for (const resolveFrom of [repoRoot, appRoot]) {
    try {
        const packageFile = require.resolve('@more-tech/react-native-libsodium/package.json', {
            paths: [resolveFrom],
        });
        cmakeFile = path.join(path.dirname(packageFile), 'android/CMakeLists.txt');
        break;
    } catch {
        // Try the next workspace root.
    }
}

if (cmakeFile && fs.existsSync(cmakeFile)) {
    const original = fs.readFileSync(cmakeFile, 'utf8');
    const marker = 'set (CMAKE_CXX_STANDARD 20)';
    const addition = `${marker}\nfile(TO_CMAKE_PATH "\${NODE_MODULES_DIR}" NODE_MODULES_DIR)`;
    const patched = original.includes('file(TO_CMAKE_PATH "${NODE_MODULES_DIR}" NODE_MODULES_DIR)')
        ? original
        : original.replace(marker, addition);

    if (patched !== original) {
        fs.writeFileSync(cmakeFile, patched, 'utf8');
        console.log('[patch] Normalized react-native-libsodium CMake paths');
    }
}
