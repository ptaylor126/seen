import {
    Modal,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import {
    type CommentMenuTarget,
    type ReactionEmoji,
    REACTION_EMOJIS,
} from '@/components/thread/shared';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

const REACTION_PICKER_SIZE = 40;

// Long-press popover for comment reactions + per-comment actions. Extracted
// verbatim from rec/[recId].tsx. Lean version: no full-screen dim, no spring
// animation, no haptics. The backdrop Pressable is a sibling of the popover
// (NOT a parent) so taps on the popover's emoji / action Pressables capture
// first; taps outside the popover land on the backdrop and dismiss.
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
                    style={[styles.commentMenuContainer, { top: menu.anchorY }]}
                >
                    <View
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
                                <View
                                    style={[
                                        styles.commentMenuActions,
                                        { borderTopColor: palette.border },
                                    ]}
                                >
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
                    </View>
                </View>
            ) : null}
        </Modal>
    );
}

const styles = StyleSheet.create({
    // Container spans the full width at the anchored Y so its child
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
    commentMenuActions: {
        marginTop: spacing.sm,
        paddingTop: spacing.sm,
        borderTopWidth: StyleSheet.hairlineWidth,
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
