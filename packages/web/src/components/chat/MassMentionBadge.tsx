import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MassMentionKeyword } from '@backspace/shared/src/mentions';
import { useSpaceStore } from '../../stores/spaceStore';

/** `@everyone` / `@here`, and a role with no colour of its own. */
const ACCENT_COLOR = '#7c6cf6';
/** A role token this client cannot place in the channel's space. */
const UNRESOLVED_COLOR = '#a0a0aa';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

type MassMentionBadgeProps =
  | { keyword: MassMentionKeyword; roleId?: undefined; channelId: string | null }
  | { roleId: string; keyword?: undefined; channelId: string | null };

/**
 * `@everyone`, `@here` or a role mention (`<@&id>`) as a label. These name a
 * group, not a person, so unlike `MentionBadge` there is no profile to open.
 * A role resolves among the roles of the channel's own space; a role this
 * client does not know there shows the unknown-role label.
 */
export const MassMentionBadge = React.memo(function MassMentionBadge({ keyword, roleId, channelId }: MassMentionBadgeProps) {
  const { t } = useTranslation('chat');
  const role = useSpaceStore((s) => {
    if (roleId === undefined || !channelId) return undefined;
    const spaceId = s.channelToSpaceMap.get(channelId);
    return spaceId === undefined ? undefined : s.roles.find((r) => r.id === roleId && r.spaceId === spaceId);
  });

  let label: string;
  let color: string;
  if (keyword !== undefined) {
    label = keyword;
    color = ACCENT_COLOR;
  } else if (role) {
    // The @everyone role is stored with its "@" in the name.
    label = role.name.replace(/^@/, '');
    color = HEX_COLOR.test(role.color) ? role.color : ACCENT_COLOR;
  } else {
    label = t('message.mention.unknownRole');
    color = UNRESOLVED_COLOR;
  }

  // Isolated like a person mention: a role or keyword label must not set the
  // message's paragraph direction.
  return (
    <span className="inline-flex items-center rounded-[3px] px-[2px] font-medium" style={{ color, backgroundColor: color + '1a' }}>
      <bdi>@{label}</bdi>
    </span>
  );
});
