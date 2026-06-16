// Metro config — adds the react-native-svg-transformer so .svg files
// can be imported directly as React components (the
// react-native-svg-based AST is generated at bundle time):
//
//     import HomeIcon from './home.svg';
//     <HomeIcon width={24} height={24} color={palette.accent} />
//
// Without this config Metro treats .svg as an asset (returns a URI),
// not a component. The config snippet is the Expo-documented shape:
// pull in Expo's default config, swap the babelTransformerPath, then
// move 'svg' from assetExts to sourceExts so Metro routes .svg files
// through the transformer.
//
// After this file lands, Metro's cache must be flushed for it to pick
// up the new transformer wiring — `npx expo start --clear` once.

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.transformer.babelTransformerPath = require.resolve(
    'react-native-svg-transformer/expo',
);
config.resolver.assetExts = config.resolver.assetExts.filter(
    (ext) => ext !== 'svg',
);
config.resolver.sourceExts = [...config.resolver.sourceExts, 'svg'];

module.exports = config;
