import { useEffect, useState } from 'react';
import {
    Keyboard,
    LayoutAnimation,
    Platform,
    UIManager,
} from 'react-native';

// One-time Android opt-in for LayoutAnimation. iOS has it on by default.
if (
    Platform.OS === 'android' &&
    UIManager.setLayoutAnimationEnabledExperimental
) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

// True while the soft keyboard is open. Use to swap layout padding /
// insets when keyboard avoidance alone doesn't give precise control —
// e.g. dropping a SafeAreaView's bottom inset when the keyboard covers
// the home indicator anyway.
//
// On each transition the hook configures a LayoutAnimation matching
// the keyboard's animation duration, so any layout change that
// happens in the same render (footer paddingBottom shrinking, etc.)
// animates smoothly alongside the keyboard slide instead of snapping.
export function useKeyboardOpen(): boolean {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const showEvent =
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent =
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvent, (e) => {
            LayoutAnimation.configureNext({
                duration: e.duration || 250,
                update: { type: LayoutAnimation.Types.easeOut },
            });
            setOpen(true);
        });
        const hideSub = Keyboard.addListener(hideEvent, (e) => {
            LayoutAnimation.configureNext({
                duration: e.duration || 250,
                update: { type: LayoutAnimation.Types.easeIn },
            });
            setOpen(false);
        });
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);
    return open;
}
