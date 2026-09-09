/**
 * React Native 0.83 ships foojay-resolver-convention 0.5.0, which is not
 * compatible with Gradle 9's current JVM vendor constants. Use the maintained
 * 1.x plugin until React Native updates its bundled Gradle settings.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.join(repoRoot, 'packages/happy-app');
let settingsFile;

for (const resolveFrom of [repoRoot, appRoot]) {
    try {
        const reactNativeDir = path.dirname(require.resolve('react-native/package.json', { paths: [resolveFrom] }));
        const pluginPackage = require.resolve('@react-native/gradle-plugin/package.json', {
            paths: [resolveFrom, reactNativeDir],
        });
        settingsFile = path.join(path.dirname(pluginPackage), 'settings.gradle.kts');
        break;
    } catch {
        // Try the next workspace root.
    }
}

if (settingsFile && fs.existsSync(settingsFile)) {
    const original = fs.readFileSync(settingsFile, 'utf8');
    const patched = original.replace(
        'foojay-resolver-convention").version("0.5.0")',
        'foojay-resolver-convention").version("1.0.0")'
    );

    if (patched !== original) {
        fs.writeFileSync(settingsFile, patched, 'utf8');
        console.log('[patch] Updated React Native foojay resolver for Gradle 9');
    }
}
