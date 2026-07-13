import { MotiView } from 'moti';
import { useState } from 'react';
import {
    Dimensions,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    type CommentMenuTarget,
    type ReactionEmoji,
    REACTION_EMOJIS,
} from '@/components/thread/shared';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

const REACTION_PICKER_SIZE = 40;
// Gap between the popover and the long-pressed bubble.
const ANCHOR_GAP = spacing.sm;

// Long-press popover for comment reactions + per-comment actions. Extracted
// from rec/[recId].tsx. Lean version: no full-screen dim, no haptics. The
// backdrop Pressable is a sibling of the popover (NOT a parent) so taps on
// the popover's emoji / action Pressables capture first; taps outside land
// on the backdrop and dismiss.
//
// Positioning: anchorY is the long-press pageY — an ABSOLUTE screen
// coordinate. Because this renders in a Modal (a separate native root,
// OUTSIDE the thread's KeyboardAvoidingView), the old `top: anchorY` placed
// the popover using a coordinate from the keyboard-shifted layout inside the
// keyboard-agnostic Modal space — so with the keyboard up it landed off the
// bubble and could sit under the keyboard. Instead we open ABOVE the anchor
// (iMessage-style) and CLAMP within the visible viewport (screen minus the
// live keyboard height + safe insets), correct whether the keyboard is up
// or down.
//
// Each item dismisses the popover (onClose) before calling its handler so any
// follow-up dialog (Alert) lands on a clean screen — the caller owns the
// actual delete / report flows.
export function ThreadCommentMenu({
    menu,
    onClose,
    onReact,
    onDelete,
    onReport,
}: {
    // null = hidden. anchorY positions the popover at the long-press point.
    menu: CommentMenuTarget | null;
    onClose: () => void;
    onReact: (commentId: string, emoji: ReactionEmoji) => void;
    onDelete: (commentId: string) => void;
    onReport: (commentId: string, authorId: string) => void;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    const keyboardState = useKeyboardState();
    // Measured popover height → lets us place it ABOVE the anchor and clamp
    // its bottom. 0 until first layout; the fade-in masks the one-frame
    // reposition, and the height persists across opens so most reopens are
    // already correct.
    const [menuHeight, setMenuHeight] = useState(0);

    const screenHeight = Dimensions.get('window').height;
    // anchorY is the pressed bubble's TOP in window space (measureInWindow
    // in comment-list) — NOT the touch point — so the menu sits a constant
    // gap above the message regardless of where inside it the press landed.
    const anchorY = menu?.anchorY ?? 0;
    const minTop = insets.top + spacing.base;
    // Bottom of the usable area: above the keyboard (live height) and the
    // home-indicator inset.
    const visibleBottom =
        screenHeight - keyboardState.height - insets.bottom - spacing.base;
    // Menu bottom a constant ANCHOR_GAP above the bubble's top. If opening
    // above would clip the safe top, flip to below the bubble; then a
    // last-resort viewport clamp keeps it off the keyboard / an edge.
    let top = anchorY - menuHeight - ANCHOR_GAP;
    if (top < minTop) top = anchorY + ANCHOR_GAP;
    if (menuHeight > 0 && top + menuHeight > visibleBottom) {
        top = visibleBottom - menuHeight;
    }
    if (top < minTop) top = minTop;

    return (
        <Modal
            transparent
            visible={!!menu}
            animationType="none"
            onRequestClose={onClose}
        >
            <Pressable
                style={StyleSheet.absoluteFillObject}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close menu"
            />
            {menu ? (
                <View
                    pointerEvents="box-none"
                    style={[styles.commentMenuContainer, { top }]}
                >
                    <MotiView
                        onLayout={(e) =>
                            setMenuHeight(e.nativeEvent.layout.height)
                        }
                        from={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'timing', duration: 180 }}
                        style={[
                            styles.commentMenu,
                            {
                                backgroundColor: palette.surface,
                                borderColor: palette.border,
                            },
                        ]}
                    >
                        <View style={styles.commentMenuEmojiRow}>
                            {REACTION_EMOJIS.map((emoji) => (
                                <Pressable
                                    key={emoji}
                                    onPress={() => {
                                        const cid = menu.commentId;
                                        onClose();
                                        onReact(cid, emoji);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={`React with ${emoji}`}
                                    style={({ pressed }) => [
                                        styles.commentMenuEmojiCell,
                                        {
                                            backgroundColor:
                                                palette.surfaceAlt,
                                            opacity: pressed ? 0.6 : 1,
                                        },
                                    ]}
                                >
                                    <Text style={styles.reactionEmoji}>
                                        {emoji}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                        {/* Actions menu — only for own comments. Built
                            as a mapped array so adding Edit (or any
                            future item) is one line, not a refactor.
                            Each item dismisses the popover before
                            calling its handler so any follow-up
                            dialog (Alert) lands on a clean screen. */}
                        {(() => {
                            // Own comment → Delete; someone else's →
                            // Report (App Store 1.2). Never both — you
                            // can't report your own comment. authorId
                            // guards a deleted author (nothing to
                            // attribute a report to). One shared map.
                            const menuActions: Array<{
                                label: string;
                                destructive?: boolean;
                                onPress: () => void;
                            }> = menu.isOwn
                                ? [
                                      {
                                          label: 'Delete',
                                          destructive: true,
                                          onPress: () => {
                                              const cid = menu.commentId;
                                              onClose();
                                              onDelete(cid);
                                          },
                                      },
                                  ]
                                : menu.authorId
                                  ? [
                                        {
                                            label: 'Report',
                                            destructive: true,
                                            onPress: () => {
                                                const cid = menu.commentId;
                                                const aid = menu.authorId;
                                                onClose();
                                                if (aid) onReport(cid, aid);
                                            },
                                        },
                                    ]
                                  : [];
                            return menuActions.length > 0 ? (
                                <View style={styles.commentMenuActions}>
                                    {menuActions.map((action) => (
                                        <Pressable
                                            key={action.label}
                                            onPress={action.onPress}
                                            accessibilityRole="button"
                                            accessibilityLabel={action.label}
                                            style={({ pressed }) => [
                                                styles.commentMenuActionItem,
                                                { opacity: pressed ? 0.6 : 1 },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    typography.body,
                                                    {
                                                        color: action.destructive
                                                            ? palette.error
                                                            : palette.text,
                                                    },
                                                ]}
                                            >
                                                {action.label}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </View>
                            ) : null;
                        })()}
                    </MotiView>
                </View>
            ) : null}
        </Modal>
    );
}

const styles = StyleSheet.create({
    // Container spans the full width at the computed `top` so its child
    // popover can self-center horizontally. pointerEvents='box-none' on
    // the container lets backdrop taps fall through any empty space
    // around the popover sheet itself.
    commentMenuContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'center',
        paddingHorizontal: spacing.base,
    },
    commentMenu: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
        paddingVertical: spacing.sm,
        minWidth: 240,
        maxWidth: 320,
    },
    commentMenuEmojiRow: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingHorizontal: spacing.sm,
    },
    commentMenuEmojiCell: {
        width: REACTION_PICKER_SIZE,
        height: REACTION_PICKER_SIZE,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Actions sit below the emoji row separated by spacing alone — no
    // divider line (removed per design). marginTop keeps them clearly
    // distinct from the reactions above.
    commentMenuActions: {
        marginTop: spacing.xs,
    },
    commentMenuActionItem: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    reactionEmoji: {
        fontSize: 22,
        lineHeight: 24,
    },
});
