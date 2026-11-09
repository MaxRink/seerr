import JellyfinAPI, { type JellyfinUserResponse } from '@server/api/jellyfin';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { LinkedAccount } from '@server/entity/LinkedAccount';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { OidcProvider } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';

export type OnboardResult =
  /** A Seerr user was linked (and imported, if needed); log them in. */
  | { type: 'linked'; user: User; imported: boolean }
  /** Not eligible; the caller falls back to the regular OIDC behaviour. */
  | { type: 'skip'; reason: string }
  /** Eligible but unsafe; the caller must reject the login. */
  | { type: 'refused'; status: number; error: ApiErrorCode; reason: string };

/**
 * Applies the provider's username map with the semantics of the Jellyfin
 * SSO-Auth plugin (ResolveMappedUsername): keys are trimmed and compared
 * case-insensitively, values are trimmed, empty values are ignored.
 */
export function resolveJellyfinUsername(
  username: string,
  map: Record<string, string> | undefined
): { name: string; mapped: boolean } {
  for (const [key, value] of Object.entries(map ?? {})) {
    if (key.trim().toLowerCase() === username.toLowerCase() && value?.trim()) {
      return { name: value.trim(), mapped: true };
    }
  }
  return { name: username, mapped: false };
}

/** Jellyfin resolves user names ordinally and case-insensitively. */
export function findJellyfinUserByName(
  users: JellyfinUserResponse[],
  name: string
): JellyfinUserResponse | undefined {
  const wanted = name.toLowerCase();
  return users.find((u) => u.Name.toLowerCase() === wanted);
}

/** The Seerr user the admin "Import Jellyfin users" action creates. */
export function buildImportedJellyfinUser(
  jellyfinUser: JellyfinUserResponse
): User {
  const settings = getSettings();
  return new User({
    jellyfinUsername: jellyfinUser.Name,
    jellyfinUserId: jellyfinUser.Id,
    jellyfinDeviceId: Buffer.from(`BOT_seerr_${jellyfinUser.Name}`).toString(
      'base64'
    ),
    email: jellyfinUser.Name,
    permissions: settings.main.defaultPermissions,
    avatar: `/avatarproxy/${jellyfinUser.Id}`,
    userType:
      settings.main.mediaServerType === MediaServerType.JELLYFIN
        ? UserType.JELLYFIN
        : UserType.EMBY,
  });
}

async function getJellyfinUsers(): Promise<JellyfinUserResponse[]> {
  const settings = getSettings();
  const admin = await getRepository(User).findOneOrFail({
    where: { id: 1 },
    select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
  });
  const client = new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId ?? ''
  );
  client.setUserId(admin.jellyfinUserId ?? '');
  return (await client.getUsers()).users;
}

/**
 * Links a first-time OIDC identity to its Jellyfin account in Seerr,
 * importing the Jellyfin user when Seerr does not know it yet. Matching is by
 * the preferred_username claim (after the username map), never by e-mail.
 */
export async function autoOnboardJellyfin(
  provider: OidcProvider,
  claims: Record<string, unknown>
): Promise<OnboardResult> {
  const settings = getSettings();
  const skip = (reason: string): OnboardResult => ({ type: 'skip', reason });
  const refuse = (
    status: number,
    error: ApiErrorCode,
    reason: string
  ): OnboardResult => ({ type: 'refused', status, error, reason });

  if (!provider.autoOnboardJellyfin) return skip('feature disabled');
  if (settings.main.mediaServerType !== MediaServerType.JELLYFIN) {
    return skip('media server is not Jellyfin');
  }

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const username =
    typeof claims.preferred_username === 'string'
      ? claims.preferred_username.trim()
      : '';
  if (!sub || !username || claims.email_verified !== true) {
    return skip('preferred_username or verified e-mail missing');
  }

  const gate = provider.autoOnboardGroups ?? ['users'];
  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === 'string')
    : [];
  if (gate.length > 0 && !gate.some((g) => groups.includes(g))) {
    return skip('not in an auto-onboarding group');
  }

  const { name, mapped } = resolveJellyfinUsername(
    username,
    provider.jellyfinUsernameMap
  );
  const jellyfinUser = findJellyfinUserByName(await getJellyfinUsers(), name);
  const jellyfinUserId = normalizeJellyfinGuid(jellyfinUser?.Id);
  if (!jellyfinUser || !jellyfinUserId || jellyfinUser.Policy?.IsDisabled) {
    return skip(`no enabled Jellyfin user named ${name}`);
  }

  const userRepository = getRepository(User);
  const linkedAccountRepository = getRepository(LinkedAccount);
  const existing = await userRepository.findOne({
    where: { jellyfinUserId },
    relations: { linkedAccounts: true },
  });

  if (existing) {
    if (existing.hasPermission(Permission.ADMIN) && !mapped) {
      return refuse(
        403,
        ApiErrorCode.Unauthorized,
        `Seerr user ${existing.id} is an administrator and ${username} is not in the username map`
      );
    }
    // Explicit map entries may bind several identities to one account (the
    // owner configured them); name matches may not take over a linked user.
    const otherLink = (existing.linkedAccounts ?? []).find(
      (a) => a.provider === provider.slug && a.sub !== sub
    );
    if (otherLink && !mapped) {
      return refuse(
        409,
        ApiErrorCode.OidcAccountAlreadyLinked,
        `Seerr user ${existing.id} is already linked to another ${provider.slug} identity`
      );
    }
    await linkedAccountRepository.save(
      new LinkedAccount({
        user: existing,
        provider: provider.slug,
        sub,
        username,
      })
    );
    logger.info('Auto-linked OIDC identity to existing Jellyfin user', {
      label: 'Auth',
      provider: provider.slug,
      username,
      jellyfinUsername: jellyfinUser.Name,
      userId: existing.id,
      mapped,
    });
    return { type: 'linked', user: existing, imported: false };
  }

  const user = buildImportedJellyfinUser(jellyfinUser);
  user.linkedAccounts = [
    new LinkedAccount({ user, provider: provider.slug, sub, username }),
  ];
  try {
    await userRepository.save(user);
  } catch (e) {
    return refuse(
      409,
      ApiErrorCode.OidcAccountAlreadyLinked,
      `importing Jellyfin user ${jellyfinUser.Name} failed: ${e.message}`
    );
  }
  logger.info('Imported Jellyfin user on first OIDC login', {
    label: 'Auth',
    provider: provider.slug,
    username,
    jellyfinUsername: jellyfinUser.Name,
    userId: user.id,
    mapped,
  });
  return { type: 'linked', user, imported: true };
}
