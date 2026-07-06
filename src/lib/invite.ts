import { Platform, Share } from 'react-native';

// Shared "Invite friends" action. Opens the OS share sheet with the App Store
// link + a short pitch — the SAME flow the friends/add "Invite friends" button
// uses. Extracted here so the friends empty-state button and the add-screen
// button can't drift. Does NOT auto-connect the recipient as a friend (that's
// the deferred invite-link deep-link project; see src/app/friends/invite.tsx).
//
// On iOS the link is a separate `url` item so iOS builds a rich
// LinkPresentation preview (Seen's icon + name from the App Store listing).
// Android's Share ignores `url`, so there the link goes inline in the message.
// A cancel rejects the promise, which we swallow.
const APP_STORE_URL = 'https://apps.apple.com/app/id6775920785';
const INVITE_PITCH =
    'Join me on Seen — recommendations from friends you actually trust.';

export async function shareInvite(): Promise<void> {
    try {
        await Share.share(
            Platform.OS === 'ios'
                ? { message: INVITE_PITCH, url: APP_STORE_URL }
                : { message: `${INVITE_PITCH} ${APP_STORE_URL}` },
        );
    } catch (err) {
        console.error('invite share failed:', err);
    }
}
