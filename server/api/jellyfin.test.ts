import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

describe('Jellyfin library requests', () => {
  it('sends the configured user ID on every user-scoped Jellyfin request', async () => {
    const settings = getSettings();
    const originalMediaServerType = settings.main.mediaServerType;
    settings.main.mediaServerType = MediaServerType.JELLYFIN;

    try {
      const api = new JellyfinAPI('http://jellyfin.test', 'test-token');
      const calls: Array<{ endpoint: string; params?: Record<string, unknown> }> = [];
      const getMock = mock.method(
        (api as unknown as { axios: { get: Function } }).axios,
        'get',
        async (endpoint: string, config?: { params?: Record<string, unknown> }) => {
          calls.push({ endpoint, params: config?.params });
          return endpoint === '/Users/Me'
            ? { data: { Id: '123e4567e89b12d3a456426614174000' } }
            : { data: { Items: [] } };
        }
      );

      await api.getLibraryContents('library-1');
      await api.getItemData('item-1');
      await api.getSeasons('series-1');
      await api.getEpisodes('series-1', 'season-1');
      getMock.mock.restore();

      assert.equal(calls[0].endpoint, '/Users/Me');
      assert.match(calls[1].endpoint, /[?&]userId=123e4567-e89b-12d3-a456-426614174000$/);
      assert.equal(calls[2].params?.userId, '123e4567-e89b-12d3-a456-426614174000');
      assert.equal(calls[3].params?.userId, '123e4567-e89b-12d3-a456-426614174000');
      assert.equal(calls[4].params?.userId, '123e4567-e89b-12d3-a456-426614174000');
    } finally {
      settings.main.mediaServerType = originalMediaServerType;
    }
  });

  it('rejects a missing or non-GUID resolved Jellyfin user before item reads', async () => {
    const settings = getSettings();
    const originalMediaServerType = settings.main.mediaServerType;
    settings.main.mediaServerType = MediaServerType.JELLYFIN;

    try {
      const api = new JellyfinAPI('http://jellyfin.test', 'test-token');
      const endpoints: string[] = [];
      const getMock = mock.method(
        (api as unknown as { axios: { get: Function } }).axios,
        'get',
        async (endpoint: string) => {
          endpoints.push(endpoint);
          return { data: { Id: 'not-a-guid' } };
        }
      );

      await assert.rejects(() => api.getItemData('item-1'));
      getMock.mock.restore();
      assert.deepEqual(endpoints, ['/Users/Me']);
    } finally {
      settings.main.mediaServerType = originalMediaServerType;
    }
  });

  it('does not add the Jellyfin-only user parameter for Emby', async () => {
    const settings = getSettings();
    const originalMediaServerType = settings.main.mediaServerType;
    settings.main.mediaServerType = MediaServerType.EMBY;

    try {
      const api = new JellyfinAPI('http://emby.test', 'test-token');
      api.setUserId('emby-user-123');
      const calls: Array<{ endpoint: string; params?: Record<string, unknown> }> = [];
      const getMock = mock.method(
        (api as unknown as { axios: { get: Function } }).axios,
        'get',
        async (endpoint: string, config?: { params?: Record<string, unknown> }) => {
          calls.push({ endpoint, params: config?.params });
          return { data: { Items: [] } };
        }
      );

      await api.getItemData('item-1');
      assert.equal(calls[0].params?.userId, undefined);
      getMock.mock.restore();
    } finally {
      settings.main.mediaServerType = originalMediaServerType;
    }
  });
});
