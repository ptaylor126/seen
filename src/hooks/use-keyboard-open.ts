import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

// True while the soft keyboard is open. Use this to swap layout
// padding/insets when keyboard avoidance alone doesn't give precise
// control — e.g. dropping a SafeAreaView's bottom inset when the
// keyboard covers the home indicator anyway.
//
// iOS gets `keyboardWillShow`/`Hide` (animations fire BEFORE the
// keyboard moves, so layout updates are in sync). Android only has
// `keyboardDidShow`/`Hide` (post-event).
export function useKeyboardOpen(): boolean {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const showEvent =
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent =
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvent, () => setOpen(true));
        const hideSub = Keyboard.addListener(hideEvent, () => setOpen(false));
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);
    return open;
}
