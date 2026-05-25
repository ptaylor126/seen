import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

// Soft keyboard state. `open` flips on keyboardWill(Show|Hide); `height`
// captures the keyboard's `endCoordinates.height` so callers can position
// floating UI (e.g. an absolutely-positioned footer) at the exact top
// edge of the keyboard.
//
// No LayoutAnimation is configured here. Callers that need to animate
// in sync with the keyboard slide should drive their own animation; the
// onboarding screens deliberately *don't* animate the footer position —
// they snap it via absolute positioning so the buttons appear at their
// final spot the moment the keyboard begins rising, rather than sliding
// up alongside it.
export function useKeyboard(): { open: boolean; height: number } {
    const [state, setState] = useState({ open: false, height: 0 });
    useEffect(() => {
        const showEvent =
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent =
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvent, (e) => {
            setState({ open: true, height: e.endCoordinates.height });
        });
        const hideSub = Keyboard.addListener(hideEvent, () => {
            setState({ open: false, height: 0 });
        });
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);
    return state;
}
