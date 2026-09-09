const { withAppBuildGradle } = require('@expo/config-plugins');

module.exports = function withPreviewSigning(config) {
    return withAppBuildGradle(config, (gradleConfig) => {
        if (gradleConfig.modResults.language !== 'groovy') {
            throw new Error('Preview signing requires a Groovy app/build.gradle');
        }

        let contents = gradleConfig.modResults.contents;
        const debugBlock = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }`;
        const previewBlock = `${debugBlock}
        preview {
            if (project.hasProperty('HAPPY_PREVIEW_STORE_FILE')) {
                storeFile file(HAPPY_PREVIEW_STORE_FILE)
                storePassword HAPPY_PREVIEW_STORE_PASSWORD
                keyAlias HAPPY_PREVIEW_KEY_ALIAS
                keyPassword HAPPY_PREVIEW_KEY_PASSWORD
            }
        }`;

        if (!contents.includes('HAPPY_PREVIEW_STORE_FILE')) {
            contents = contents.replace(debugBlock, previewBlock);
            contents = contents.replace(
                'signingConfig signingConfigs.debug\n            def enableShrinkResources',
                `signingConfig project.hasProperty('HAPPY_PREVIEW_STORE_FILE')
                ? signingConfigs.preview
                : signingConfigs.debug
            def enableShrinkResources`
            );
        }

        if (!contents.includes("signingConfigs.preview")) {
            throw new Error('Could not configure the Android preview signing key');
        }

        gradleConfig.modResults.contents = contents;
        return gradleConfig;
    });
};
