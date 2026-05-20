import { Stack } from 'expo-router';

// No header on any onboarding screen — each screen owns its own
// header layout (back button + title) so the visual hierarchy matches
// the conversational tone better than the default nav bar.
export default function OnboardingLayout() {
    return <Stack screenOptions={{ headerShown: false }} />;
}
