import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';
import type { InternalAxiosRequestConfig } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

class TestJellyfinAPI extends JellyfinAPI {
  public readonly requests: InternalAxiosRequestConfig[] = [];

  public recordRequests(): void {
    this.axios.defaults.adapter = async (config) => {
      this.requests.push(config);
      return {
        data: { Items: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
      };
    };
  }
}

async function readLibrary(api: JellyfinAPI): Promise<void> {
  await api.getLibraryContents('library-1');
  await api.getItemData('item-1');
  await api.getSeasons('series-1');
  await api.getEpisodes('series-1', 'season-1');
}

describe('JellyfinAPI library reads', () => {
  const settings = getSettings();
  const originalMediaServerType = settings.main.mediaServerType;

  afterEach(() => {
    settings.main.mediaServerType = originalMediaServerType;
  });

  it('sends the configured userId to Jellyfin', async () => {
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    const api = new TestJellyfinAPI('http://jellyfin.test', 'test-token');
    api.setUserId('user-1');
    api.recordRequests();

    await readLibrary(api);

    assert.equal(api.requests.length, 4);
    for (const request of api.requests) {
      assert.equal(request.params?.userId, 'user-1', request.url);
    }
  });

  it('does not send userId to Emby', async () => {
    settings.main.mediaServerType = MediaServerType.EMBY;
    const api = new TestJellyfinAPI('http://emby.test', 'test-token');
    api.setUserId('user-1');
    api.recordRequests();

    await readLibrary(api);

    assert.equal(api.requests.length, 4);
    for (const request of api.requests) {
      assert.equal(request.params?.userId, undefined, request.url);
    }
  });
});
