import type { Ref } from 'react';
import { TextInput as RNTextInput, type TextInputProps } from 'react-native';

import { MAX_FONT_SCALE } from '@/components/text';

// Drop-in replacement for react-native's TextInput with the same font-scale
// clamp as the Text wrapper — the fixed-height input rows (44/48pt search
// bars and form fields) fit scaled input text up to the clamp, and an
// unclamped input next to clamped labels would scale past its row. Callers
// can still override maxFontSizeMultiplier (spread wins).
export function TextInput(
    props: TextInputProps & { ref?: Ref<RNTextInput> },
) {
    return <RNTextInput maxFontSizeMultiplier={MAX_FONT_SCALE} {...props} />;
}

// Instance type (focus()/blur() refs) — keeps `useRef<TextInput>` working
// for future callers even though the value above is the wrapper.
export type TextInput = RNTextInput;
