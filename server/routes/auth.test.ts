import assert from 'node:assert/strict';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { LinkedAccount } from '@server/entity/LinkedAccount';
import { User } from '@server/entity/User';
import PreparedEmail from '@server/lib/email';
import ImageProxy from '@server/lib/imageproxy';
import { resolveJellyfinUsername } from '@server/lib/oidcJellyfinOnboard';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import {
  allowlistedSettings,
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import { ApiError } from '@server/types/error';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import fetchMock from 'fetch-mock';
import request from 'supertest';
import authRoutes from './auth';

const emailMock = mock.method(PreparedEmail.prototype, 'send', async () => {
  return undefined;
}).mock;

// Jellyfin Quick Connect mocks
const defaultInitiateResponse = {
  Secret: 'abc123def456abc123def456',
  Code: '123456',
  DateAdded: new Date().toISOString(),
};

const defaultCheckResponse = {
  Authenticated: false,
  Secret: 'abc123def456abc123def456',
  Code: '123456',
  DeviceId: 'device-1',
  DeviceName: 'Test',
  AppName: 'Seerr',
  AppVersion: '1.0',
  DateAdded: new Date().toISOString(),
};

const defaultAuthenticateResponse = {
  User: {
    Id: 'jf-qc-user-001',
    Name: 'quickconnectuser',
    ServerId: 'server-1',
    Policy: { IsAdministrator: false },
  },
  AccessToken: 'fake-qc-access-token',
};

const initiateQCMock = mock.method(
  JellyfinAPI.prototype,
  'initiateQuickConnect',
  async () => ({ ...defaultInitiateResponse })
);

const checkQCMock = mock.method(
  JellyfinAPI.prototype,
  'checkQuickConnect',
  async () => ({ ...defaultCheckResponse })
);

const authenticateQCMock = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => ({ ...defaultAuthenticateResponse })
);
const fakeAvatarBuffer = Buffer.from('fake-quickconnect-avatar-bytes');

const axiosHeadMock = mock.method(axios, 'head', async () => ({
  status: 200,
  headers: { 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
}));

const clearCachedImageMock = mock.method(
  ImageProxy.prototype,
  'clearCachedImage',
  async () => undefined
);

const getImageMock = mock.method(
  ImageProxy.prototype,
  'getImage',
  async () => ({
    imageBuffer: fakeAvatarBuffer,
    meta: {
      revalidateAfter: 3600,
      curRevalidate: 3600,
      isStale: false,
      etag: 'mock-meta-etag',
      extension: 'jpg',
      cacheKey: 'mock-cache-key',
      cacheMiss: true,
    },
  })
);

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser('SECRET'));
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  // Error handler matching how next({ status, error, message }) calls are handled
  app.use(
    (
      err: { status?: number; error?: string; message?: string },
      _req: express.Request,
      res: express.Response,
      // We must provide a next function for the function signature here even though its not used
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({
        status: err.status ?? 500,
        error: err.error,
        message: err.message,
      });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

afterEach(() => {
  getSettings().reset();
});

setupTestDb();

/** Create a supertest agent that is logged in as the given user. */
async function authenticatedAgent(email: string, password: string) {
  const agent = request.agent(app);
  const settings = getSettings();
  settings.main.localLogin = true;

  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return agent;
}

/** Configure Jellyfin settings for testing QC */
function configureJellyfin() {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.main.newPlexLogin = true;
  settings.jellyfin.ip = 'localhost';
  settings.jellyfin.port = 8096;
  settings.jellyfin.useSsl = false;
  settings.jellyfin.urlBase = '';
}

describe('POST /auth/jellyfin/quickconnect/initiate', () => {
  beforeEach(() => {
    initiateQCMock.mock.resetCalls();
    initiateQCMock.mock.mockImplementation(async () => ({
      ...defaultInitiateResponse,
    }));
    configureJellyfin();
  });

  it('returns code and secret on success', async () => {
    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.code, '123456');
    assert.strictEqual(res.body.secret, 'abc123def456abc123def456');
    assert.strictEqual(initiateQCMock.mock.callCount(), 1);
  });

  it('returns 403 when the media server is Emby', async () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');

    assert.strictEqual(res.status, 403);
    assert.strictEqual(initiateQCMock.mock.callCount(), 0);
  });

  it('returns 500 when Jellyfin API fails', async () => {
    initiateQCMock.mock.mockImplementation(async () => {
      throw new Error('Connection refused');
    });

    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');

    assert.strictEqual(res.status, 500);
    assert.match(res.body.message, /initiate quick connect/i);
  });

  it('returns 500 when initiateQuickConnect throws ApiError', async () => {
    initiateQCMock.mock.mockImplementation(async () => {
      throw new ApiError(500, ApiErrorCode.Unknown);
    });

    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');
    assert.strictEqual(res.status, 500);
  });
});

describe('GET /auth/jellyfin/quickconnect/check', () => {
  beforeEach(() => {
    checkQCMock.mock.resetCalls();
    checkQCMock.mock.mockImplementation(async () => ({
      ...defaultCheckResponse,
    }));
    configureJellyfin();
  });

  it('returns authenticated: false when not yet authorized', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.authenticated, false);
    assert.strictEqual(checkQCMock.mock.callCount(), 1);
  });

  it('returns authenticated: true when authorized', async () => {
    checkQCMock.mock.mockImplementation(async () => ({
      ...defaultCheckResponse,
      Authenticated: true,
    }));

    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.authenticated, true);
  });

  it('returns 400 when secret is missing', async () => {
    const res = await request(app).get('/auth/jellyfin/quickconnect/check');

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is too short', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'ab12' });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is too long', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'a'.repeat(129) });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret contains non-hex characters', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'zzzzzzzzzzzz' });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 403 when the media server is Emby', async () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns error when Jellyfin API fails', async () => {
    checkQCMock.mock.mockImplementation(async () => {
      throw new ApiError(500, ApiErrorCode.Unknown);
    });

    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 500);
  });
});

describe('POST /auth/jellyfin/quickconnect/authenticate', () => {
  beforeEach(() => {
    authenticateQCMock.mock.resetCalls();
    authenticateQCMock.mock.mockImplementation(async () => ({
      ...defaultAuthenticateResponse,
    }));
    axiosHeadMock.mock.resetCalls();
    clearCachedImageMock.mock.resetCalls();
    getImageMock.mock.resetCalls();
    configureJellyfin();
  });

  it('returns 400 when secret is missing', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({});

    assert.strictEqual(res.status, 400);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is not a string', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 12345678 });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is too short', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'ab12' });

    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when secret contains non-hex characters', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'zzzzzzzzzzzz' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 403 when media server is not configured', async () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /initial setup/i);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 403 when no users exist in the database', async () => {
    // Clear all users to simulate initial setup
    const userRepo = getRepository(User);
    await userRepo.clear();

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /initial setup/i);
  });

  it('signs in an existing Jellyfin user and sets session', async () => {
    const userRepo = getRepository(User);
    const existingUser = new User({
      email: 'existing-qc@seerr.dev',
      jellyfinUsername: 'quickconnectuser',
      jellyfinUserId: 'jf-qc-user-001',
      jellyfinDeviceId: 'old-device-id',
      permissions: 0,
      avatar: '/avatarproxy/jf-qc-user-001?v=0',
      userType: UserType.JELLYFIN,
    });
    await userRepo.save(existingUser);

    const agent = request.agent(app);

    const res = await agent
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
    assert.ok(!('password' in res.body));

    const meRes = await agent.get('/auth/me');
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.body.jellyfinUsername, 'quickconnectuser');

    const updatedUser = await userRepo.findOneOrFail({
      where: { jellyfinUserId: 'jf-qc-user-001' },
      select: {
        id: true,
        jellyfinAuthToken: true,
        jellyfinDeviceId: true,
      },
    });
    assert.strictEqual(updatedUser.jellyfinAuthToken, 'fake-qc-access-token');
    assert.notStrictEqual(updatedUser.jellyfinDeviceId, 'old-device-id');
  });

  it('refreshes avatarVersion/avatarETag when the remote avatar has changed', async () => {
    const userRepo = getRepository(User);
    const existingUser = new User({
      email: 'qc-avatar-change@seerr.dev',
      jellyfinUsername: 'quickconnectuser',
      jellyfinUserId: 'jf-qc-user-001',
      jellyfinDeviceId: 'old-device-id',
      permissions: 0,
      avatar: '/avatarproxy/jf-qc-user-001?v=old',
      avatarVersion: 'old-version',
      avatarETag: 'old-etag',
      userType: UserType.JELLYFIN,
    });
    await userRepo.save(existingUser);

    const agent = request.agent(app);
    const res = await agent
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);

    const updatedUser = await userRepo.findOneOrFail({
      where: { jellyfinUserId: 'jf-qc-user-001' },
    });
    assert.notStrictEqual(updatedUser.avatarVersion, 'old-version');
    assert.notStrictEqual(updatedUser.avatarETag, 'old-etag');
    assert.notStrictEqual(
      updatedUser.avatar,
      '/avatarproxy/jf-qc-user-001?v=old'
    );
  });

  it('creates a new user when newPlexLogin is enabled and user does not exist', async () => {
    const settings = getSettings();
    settings.main.newPlexLogin = true;

    authenticateQCMock.mock.mockImplementation(async () => ({
      User: {
        Id: 'jf-brand-new-user',
        Name: 'brandnewuser',
        ServerId: 'server-1',
        Policy: { IsAdministrator: false },
      },
      AccessToken: 'new-user-token',
    }));

    const agent = request.agent(app);

    const res = await agent
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);

    const userRepo = getRepository(User);
    const newUser = await userRepo.findOne({
      where: { jellyfinUserId: 'jf-brand-new-user' },
    });
    assert.ok(newUser);
    assert.strictEqual(newUser.jellyfinUsername, 'brandnewuser');
    assert.strictEqual(newUser.userType, UserType.JELLYFIN);

    const meRes = await agent.get('/auth/me');
    assert.strictEqual(meRes.status, 200);
  });

  it('returns 403 when the media server is Emby', async () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('applies default permissions to newly created users', async () => {
    const settings = getSettings();
    settings.main.newPlexLogin = true;
    settings.main.defaultPermissions = 32;

    authenticateQCMock.mock.mockImplementation(async () => ({
      User: {
        Id: 'jf-perms-test-user',
        Name: 'permsuser',
        ServerId: 'server-1',
        Policy: { IsAdministrator: false },
      },
      AccessToken: 'perms-token',
    }));

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);

    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({
      where: { jellyfinUserId: 'jf-perms-test-user' },
    });
    assert.strictEqual(user.permissions, 32);
  });

  it('returns 403 when newPlexLogin is disabled and user does not exist', async () => {
    const settings = getSettings();
    settings.main.newPlexLogin = false;

    authenticateQCMock.mock.mockImplementation(async () => ({
      User: {
        Id: 'jf-unknown-user',
        Name: 'unknownuser',
        ServerId: 'server-1',
        Policy: { IsAdministrator: false },
      },
      AccessToken: 'unknown-token',
    }));

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, 'Access denied.');
  });

  it('returns error when Jellyfin authenticateQuickConnect fails', async () => {
    authenticateQCMock.mock.mockImplementation(async () => {
      throw new ApiError(401, ApiErrorCode.InvalidCredentials);
    });

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.message, ApiErrorCode.InvalidCredentials);
  });

  it('returns 500 when Jellyfin throws a generic error', async () => {
    authenticateQCMock.mock.mockImplementation(async () => {
      throw new Error('Network timeout');
    });

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 500);
  });
});

describe('GET /auth/me', () => {
  it('returns 403 when not authenticated', async () => {
    const res = await request(app).get('/auth/me');
    assert.strictEqual(res.status, 403);
  });

  it('returns the authenticated user', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev', 'test1234');

    const res = await agent.get('/auth/me');

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
    assert.strictEqual(res.body.displayName, 'admin');
  });

  it('includes userEmailRequired warning when email is required but invalid', async () => {
    const settings = getSettings();
    settings.notifications.agents.email.options.userEmailRequired = true;

    // Change the user's email to something invalid
    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    user.email = 'not-an-email';
    await userRepo.save(user);

    // Log in with the changed email
    const agent = request.agent(app);
    settings.main.localLogin = true;
    const loginRes = await agent
      .post('/auth/local')
      .send({ email: 'not-an-email', password: 'test1234' });
    assert.strictEqual(loginRes.status, 200);

    const res = await agent.get('/auth/me');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.warnings.includes('userEmailRequired'));

    settings.notifications.agents.email.options.userEmailRequired = false;
  });

  it('returns only the allowlisted settings fields', async () => {
    await seedUserSettings('admin@seerr.dev');
    const agent = await authenticatedAgent('admin@seerr.dev', 'test1234');

    const res = await agent.get('/auth/me');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body.settings).sort(), [
      'discoverRegion',
      'locale',
      'notificationTypes',
      'originalLanguage',
      'streamingRegion',
      'watchlistSyncMovies',
      'watchlistSyncTv',
    ]);
    assert.strictEqual(res.body.settings.locale, allowlistedSettings.locale);
    assert.strictEqual(
      res.body.settings.discoverRegion,
      allowlistedSettings.discoverRegion
    );
    assertNoCredentials(res.body);
  });
});

describe('POST /auth/local', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.main.localLogin = true;
  });

  it('returns 200 and user data on valid credentials', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
    // filter() strips sensitive fields like password
    assert.ok(!('password' in res.body));
  });

  it('returns 403 on wrong password', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'wrongpassword' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, 'Access denied.');
  });

  it('returns 403 for nonexistent user', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'nobody@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, 'Access denied.');
  });

  it('returns 500 when local login is disabled', async () => {
    const settings = getSettings();
    settings.main.localLogin = false;

    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, 'Password sign-in is disabled.');
  });

  it('returns 500 when email is missing', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ password: 'test1234' });

    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /email address and a password/);
  });

  it('returns 500 when password is missing', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev' });

    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /email address and a password/);
  });

  it('is case-insensitive for email', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'Admin@Seerr.Dev', password: 'test1234' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
  });

  it('allows the non-admin user to log in', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'demo@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
  });

  it('sets a session on successful login', async () => {
    const agent = request.agent(app);

    await agent
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });

    // Session should persist — /me should succeed
    const meRes = await agent.get('/auth/me');
    assert.strictEqual(meRes.status, 200);
  });
});

describe('POST /auth/logout', () => {
  it('returns 200 when not logged in', async () => {
    const res = await request(app).post('/auth/logout');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  it('destroys session and returns 200 when logged in', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev', 'test1234');

    // Verify session is active
    const meBeforeRes = await agent.get('/auth/me');
    assert.strictEqual(meBeforeRes.status, 200);

    const logoutRes = await agent.post('/auth/logout');
    assert.strictEqual(logoutRes.status, 200);
    assert.strictEqual(logoutRes.body.status, 'ok');

    // Session should be invalidated — /me should fail
    const meAfterRes = await agent.get('/auth/me');
    assert.strictEqual(meAfterRes.status, 403);
  });
});

describe('POST /auth/reset-password', () => {
  beforeEach(() => {
    emailMock.resetCalls();
  });

  it('returns 200 for a valid email', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ email: 'admin@seerr.dev' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(emailMock.callCount(), 1);
  });

  it('returns 200 for nonexistent email (does not reveal user existence)', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ email: 'nonexistent@seerr.dev' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(emailMock.callCount(), 0);
  });

  it('returns 500 when email is missing', async () => {
    const res = await request(app).post('/auth/reset-password').send({});

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Email address required.');
    assert.strictEqual(emailMock.callCount(), 0);
  });

  it('sets a resetPasswordGuid on the user', async () => {
    await request(app)
      .post('/auth/reset-password')
      .send({ email: 'admin@seerr.dev' });

    const userRepo = getRepository(User);
    const user = await userRepo
      .createQueryBuilder('user')
      .addSelect(['user.resetPasswordGuid', 'user.recoveryLinkExpirationDate'])
      .where('user.email = :email', { email: 'admin@seerr.dev' })
      .getOneOrFail();

    assert.notStrictEqual(user.resetPasswordGuid, undefined);
    assert.notStrictEqual(user.resetPasswordGuid, null);
    assert.notStrictEqual(user.recoveryLinkExpirationDate, undefined);
    assert.strictEqual(emailMock.callCount(), 1);
  });
});

describe('POST /auth/reset-password/:guid', () => {
  /** Trigger a password reset and return the guid. */
  async function getResetGuid(email: string): Promise<string> {
    await request(app).post('/auth/reset-password').send({ email });

    const userRepo = getRepository(User);
    const user = await userRepo
      .createQueryBuilder('user')
      .addSelect('user.resetPasswordGuid')
      .where('user.email = :email', { email })
      .getOneOrFail();

    return user.resetPasswordGuid!;
  }

  it('resets password with a valid guid and password', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'newpassword123' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');

    // Old password no longer works
    const oldLogin = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.strictEqual(oldLogin.status, 403);

    // New password works
    const newLogin = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'newpassword123' });
    assert.strictEqual(newLogin.status, 200);
  });

  it('returns 500 for an invalid guid', async () => {
    const res = await request(app)
      .post('/auth/reset-password/invalid-guid-here')
      .send({ password: 'newpassword123' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Invalid password reset link.');
  });

  it('returns 500 when password is too short', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'short' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(
      res.body.message,
      'Password must be at least 8 characters long.'
    );
  });

  it('returns 500 when password is missing', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({});

    assert.strictEqual(res.status, 500);
    assert.strictEqual(
      res.body.message,
      'Password must be at least 8 characters long.'
    );
  });

  it('returns 500 for an expired recovery link', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    // Expire the link
    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    user.recoveryLinkExpirationDate = new Date('2020-01-01');
    await userRepo.save(user);

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'newpassword123' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Invalid password reset link.');
  });

  it('cannot reuse a guid after successful reset', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    // First reset succeeds
    const first = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'newpassword123' });
    assert.strictEqual(first.status, 200);

    // Second reset with same guid fails (recoveryLinkExpirationDate was cleared)
    const second = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'anotherpassword' });
    assert.strictEqual(second.status, 500);
  });
});

describe('OpenID Connect', () => {
  const OIDC_REDIRECT_URL = 'https://jellyseerr.example.com/login';

  // Default claims for new user registration tests
  const DEFAULT_CLAIMS = {
    sub: 'new-user-sub',
    email: 'newuser@example.com',
  };

  // Claims for existing seeded user (demo@seerr.dev)
  const EXISTING_USER_CLAIMS = {
    sub: 'friend-oidc-sub',
    email: 'demo@seerr.dev',
  };

  function buildMockWellKnown(options?: { supportsPKCE?: boolean }) {
    return {
      issuer: 'https://example.com',
      authorization_endpoint: 'https://example.com/oauth/authorize',
      token_endpoint: 'https://example.com/oauth/token',
      userinfo_endpoint: 'https://example.com/userinfo',
      jwks_uri: 'https://example.com/.well-known/jwks.json',
      response_types_supported: [
        'code',
        'token',
        'id_token',
        'code token',
        'code id_token',
        'token id_token',
        'code token id_token',
        'none',
      ],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
      ...(options?.supportsPKCE
        ? { code_challenge_methods_supported: ['S256'] }
        : {}),
    };
  }

  /**
   * Performs the login + callback flow and returns the callback response.
   */
  async function performOidcCallback() {
    const loginResponse = await request(app)
      .get('/auth/oidc/login/test')
      .set('Accept', 'application/json');

    assert.strictEqual(loginResponse.status, 200);

    const redirectUrl = new URL(loginResponse.body.redirectUrl);
    const state = redirectUrl.searchParams.get('state');

    const cookies = loginResponse.get('Set-Cookie');
    assert.notStrictEqual(cookies, undefined);
    const cookieHeader = cookies!.map((c) => c.split(';')[0]).join('; ');

    const callbackUrl = new URL(OIDC_REDIRECT_URL);
    callbackUrl.searchParams.set('code', '123456');
    if (state) callbackUrl.searchParams.set('state', state);

    const response = await request(app)
      .post('/auth/oidc/callback/test')
      .set('Accept', 'application/json')
      .set('Cookie', cookieHeader)
      .send({ callbackUrl: callbackUrl.toString() });

    return response;
  }

  let mockJwks: { keys: object[] };
  let signIdToken: (claims?: Record<string, unknown>) => Promise<string>;

  before(async () => {
    const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    mockJwks = { keys: [jwk] };

    signIdToken = (claims?: Record<string, unknown>) =>
      new SignJWT({ ...DEFAULT_CLAIMS, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer('https://example.com')
        .setAudience('jellyseerr')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
  });

  beforeEach(() => {
    // configure test provider settings
    getSettings().load({
      main: {
        oidcLogin: true,
        applicationUrl: new URL(OIDC_REDIRECT_URL).origin,
      },
      oidc: {
        providers: [
          {
            slug: 'test',
            name: 'Test Provider',
            clientId: 'jellyseerr',
            clientSecret: 'abcdefg',
            issuerUrl: 'https://example.com',
            newUserLogin: true,
          },
        ],
      },
    });
  });

  async function setupFetchMock(options?: {
    supportsPKCE?: boolean;
    userinfoResponse?: Record<string, unknown>;
    idTokenClaims?: Record<string, unknown>;
  }) {
    const wellKnown = buildMockWellKnown(options);
    const userinfo = options?.userinfoResponse ?? DEFAULT_CLAIMS;
    const idTokenClaims = options?.idTokenClaims;
    const idToken = await signIdToken(idTokenClaims);
    const tokenResponse = {
      access_token: 'abcdefg',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken,
    };

    fetchMock.mockGlobal();

    fetchMock.route(
      'https://example.com/.well-known/openid-configuration',
      wellKnown
    );
    fetchMock.route('https://example.com/.well-known/jwks.json', mockJwks);
    fetchMock.route('https://example.com/oauth/token', tokenResponse);
    fetchMock.route('https://example.com/userinfo', userinfo);
  }

  describe('without PKCE support (uses state)', function () {
    before(async () => {
      await setupFetchMock({ supportsPKCE: false });
    });

    after(() => {
      fetchMock.hardReset();
    });

    it('login endpoint produces correct redirect URL', async function () {
      const response = await request(app)
        .get('/auth/oidc/login/test')
        .set('Accept', 'application/json');

      assert.match(response.headers['content-type'], /json/);
      assert.strictEqual(response.status, 200);
      assert.match(
        response.body.redirectUrl,
        /^https:\/\/example.com\/oauth\/authorize\?/
      );

      const params = new URL(response.body.redirectUrl);
      assert.strictEqual(params.searchParams.get('response_type'), 'code');
      assert.strictEqual(params.searchParams.get('client_id'), 'jellyseerr');
      assert.strictEqual(
        params.searchParams.get('scope'),
        'openid profile email'
      );
      assert.strictEqual(
        params.searchParams.get('redirect_uri'),
        OIDC_REDIRECT_URL
      );
      assert.ok(params.searchParams.get('state'));
    });

    it('callback endpoint successfully authorizes existing user', async function () {
      // Link the seeded friend user to the OIDC provider
      const userRepo = getRepository(User);
      const linkedAccountRepo = getRepository(LinkedAccount);

      const user = await userRepo.findOneOrFail({
        where: { email: 'demo@seerr.dev' },
      });

      const linkedAccount = new LinkedAccount({
        user,
        provider: 'test',
        sub: EXISTING_USER_CLAIMS.sub,
        username: 'friend',
      });
      await linkedAccountRepo.save(linkedAccount);

      // Setup mock to return the existing user's claims
      await setupFetchMock({
        supportsPKCE: false,
        idTokenClaims: EXISTING_USER_CLAIMS,
        userinfoResponse: EXISTING_USER_CLAIMS,
      });

      const response = await performOidcCallback();

      assert.strictEqual(response.status, 204);
    });
  });

  describe('with PKCE support (uses state and PKCE)', function () {
    before(async () => {
      await setupFetchMock({ supportsPKCE: true });
    });

    after(() => {
      fetchMock.hardReset();
    });

    it('login endpoint includes both state and PKCE parameters', async function () {
      const response = await request(app)
        .get('/auth/oidc/login/test')
        .set('Accept', 'application/json');

      assert.strictEqual(response.status, 200);

      const params = new URL(response.body.redirectUrl);
      assert.ok(params.searchParams.get('state'));
      assert.ok(params.searchParams.get('code_challenge'));
      assert.strictEqual(
        params.searchParams.get('code_challenge_method'),
        'S256'
      );
    });

    it('callback endpoint successfully authorizes existing user', async function () {
      // Link the seeded friend user to the OIDC provider
      const userRepo = getRepository(User);
      const linkedAccountRepo = getRepository(LinkedAccount);

      const user = await userRepo.findOneOrFail({
        where: { email: 'demo@seerr.dev' },
      });

      const linkedAccount = new LinkedAccount({
        user,
        provider: 'test',
        sub: EXISTING_USER_CLAIMS.sub,
        username: 'friend',
      });
      await linkedAccountRepo.save(linkedAccount);

      // Setup mock to return the existing user's claims
      await setupFetchMock({
        supportsPKCE: true,
        idTokenClaims: EXISTING_USER_CLAIMS,
        userinfoResponse: EXISTING_USER_CLAIMS,
      });

      const response = await performOidcCallback();

      assert.strictEqual(response.status, 204);
    });
  });

  describe('new user registration', function () {
    before(async () => {
      await setupFetchMock({ supportsPKCE: false });
    });

    after(() => {
      fetchMock.hardReset();
    });

    it('creates a new user when newUserLogin is enabled', async function () {
      const settings = getSettings();
      settings.oidc.providers[0].newUserLogin = true;

      const response = await performOidcCallback();

      assert.strictEqual(response.status, 204);

      // Verify user was created in the database
      const userRepo = getRepository(User);
      const createdUser = await userRepo.findOne({
        where: { email: DEFAULT_CLAIMS.email },
      });
      assert.notStrictEqual(createdUser, null);
      assert.strictEqual(createdUser!.email, DEFAULT_CLAIMS.email);

      // Verify linked account was created
      const linkedAccountRepo = getRepository(LinkedAccount);
      const createdLink = await linkedAccountRepo.findOne({
        where: { provider: 'test', sub: DEFAULT_CLAIMS.sub },
      });
      assert.notStrictEqual(createdLink, null);
    });

    it('rejects new user when newUserLogin is disabled', async function () {
      const settings = getSettings();
      settings.oidc.providers[0].newUserLogin = false;

      const response = await performOidcCallback();

      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.error, ApiErrorCode.Unauthorized);

      // Verify no new user was created (only seeded users should exist)
      const userRepo = getRepository(User);
      const newUser = await userRepo.findOne({
        where: { email: DEFAULT_CLAIMS.email },
      });
      assert.strictEqual(newUser, null);
    });

    it('rejects new user when email is missing', async function () {
      fetchMock.hardReset();

      const settings = getSettings();
      settings.oidc.providers[0].newUserLogin = true;

      // Setup mock without email in claims (explicitly set email to undefined to override DEFAULT_CLAIMS)
      await setupFetchMock({
        supportsPKCE: false,
        idTokenClaims: { sub: 'no-email-sub', email: undefined },
        userinfoResponse: { sub: 'no-email-sub' },
      });

      const response = await performOidcCallback();

      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.body.error, ApiErrorCode.OidcMissingEmail);
    });
  });

  describe('error handling', function () {
    it('returns Unauthorized when OIDC login is disabled', async function () {
      const settings = getSettings();
      settings.main.oidcLogin = false;

      const response = await request(app)
        .get('/auth/oidc/login/test')
        .set('Accept', 'application/json');

      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.error, ApiErrorCode.Unauthorized);
    });

    it('returns Unauthorized for unknown provider', async function () {
      const response = await request(app)
        .get('/auth/oidc/login/unknown-provider')
        .set('Accept', 'application/json');

      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.error, ApiErrorCode.Unauthorized);
    });

    it('rejects callback when correlation cookies are missing', async function () {
      await setupFetchMock();

      const callbackUrl = new URL(OIDC_REDIRECT_URL);
      callbackUrl.searchParams.set('code', '123456');
      callbackUrl.searchParams.set('state', 'somestate');

      // Send callback with no signed cookies at all
      const response = await request(app)
        .post('/auth/oidc/callback/test')
        .set('Accept', 'application/json')
        .send({ callbackUrl: callbackUrl.toString() });

      assert.strictEqual(response.status, 400);
      assert.strictEqual(
        response.body.error,
        ApiErrorCode.OidcAuthorizationFailed
      );
    });

    it('rejects callback when only one correlation cookie is present', async function () {
      await setupFetchMock();

      // Perform login to get only the state cookie
      const loginResponse = await request(app)
        .get('/auth/oidc/login/test')
        .set('Accept', 'application/json');

      assert.strictEqual(loginResponse.status, 200);

      const redirectUrl = new URL(loginResponse.body.redirectUrl);
      const state = redirectUrl.searchParams.get('state');

      // Extract only the state cookie, dropping the PKCE verifier cookie
      const cookies = loginResponse.get('Set-Cookie');
      assert.notStrictEqual(cookies, undefined);
      const stateCookieOnly = cookies!
        .filter((c) => c.includes('oidc-state'))
        .map((c) => c.split(';')[0])
        .join('; ');

      const callbackUrl = new URL(OIDC_REDIRECT_URL);
      callbackUrl.searchParams.set('code', '123456');
      if (state) callbackUrl.searchParams.set('state', state);

      const response = await request(app)
        .post('/auth/oidc/callback/test')
        .set('Accept', 'application/json')
        .set('Cookie', stateCookieOnly)
        .send({ callbackUrl: callbackUrl.toString() });

      assert.strictEqual(response.status, 400);
      assert.strictEqual(
        response.body.error,
        ApiErrorCode.OidcAuthorizationFailed
      );
    });
  });

  describe('Jellyfin auto-onboarding (fork)', function () {
    const JF = {
      alice: '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a',
      jfonly: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
      admin: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
      disabled: '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d',
    };
    const JF_USERS = [
      { Id: JF.alice, Name: 'Alice', Policy: { IsAdministrator: false } },
      { Id: JF.jfonly, Name: 'JfOnly', Policy: { IsAdministrator: false } },
      { Id: JF.admin, Name: 'admin', Policy: { IsAdministrator: true } },
      {
        Id: JF.disabled,
        Name: 'Gone',
        Policy: { IsAdministrator: false, IsDisabled: true },
      },
    ];
    let getUsersMock: ReturnType<typeof mock.method>;
    let previousServerType: MediaServerType;

    const claimsFor = (
      username: string,
      extra: Record<string, unknown> = {}
    ) => ({
      sub: `sub-${username}`,
      email: `${username}@example.com`,
      email_verified: true,
      preferred_username: username,
      groups: ['users'],
      ...extra,
    });

    async function loginAs(
      username: string,
      extra: Record<string, unknown> = {}
    ) {
      const claims = claimsFor(username, extra);
      await setupFetchMock({
        supportsPKCE: true,
        idTokenClaims: { sub: claims.sub, email: claims.email },
        userinfoResponse: claims,
      });
      return performOidcCallback();
    }

    async function seerrJellyfinUser(
      name: string,
      jellyfinUserId: string,
      permissions = Permission.REQUEST
    ) {
      return getRepository(User).save(
        new User({
          email: `${name.toLowerCase()}@jellyfin.local`,
          username: name,
          jellyfinUsername: name,
          jellyfinUserId,
          permissions,
          userType: UserType.JELLYFIN,
          avatar: '',
        })
      );
    }

    const linksOf = (userId: number) =>
      getRepository(LinkedAccount).find({
        where: { user: { id: userId } },
      });

    before(() => {
      getUsersMock = mock.method(
        JellyfinAPI.prototype,
        'getUsers',
        async () => ({ users: JF_USERS })
      );
    });

    after(() => {
      getUsersMock.mock.restore();
    });

    beforeEach(() => {
      const settings = getSettings();
      previousServerType = settings.main.mediaServerType;
      settings.main.mediaServerType = MediaServerType.JELLYFIN;
      settings.main.defaultPermissions = Permission.REQUEST;
      Object.assign(settings.oidc.providers[0], {
        newUserLogin: false,
        autoOnboardJellyfin: true,
        autoOnboardGroups: undefined,
        jellyfinUsernameMap: undefined,
      });
      getUsersMock.mock.resetCalls();
    });

    afterEach(() => {
      getSettings().main.mediaServerType = previousServerType;
      fetchMock.hardReset();
    });

    it('maps usernames like the Jellyfin SSO plugin', function () {
      assert.deepStrictEqual(
        resolveJellyfinUsername('MAX', { ' max ': ' admin ' }),
        { name: 'admin', mapped: true }
      );
      assert.deepStrictEqual(resolveJellyfinUsername('max', { max: ' ' }), {
        name: 'max',
        mapped: false,
      });
      assert.deepStrictEqual(resolveJellyfinUsername('bob', undefined), {
        name: 'bob',
        mapped: false,
      });
    });

    it('links an existing Seerr Jellyfin user by case-insensitive name', async function () {
      const alice = await seerrJellyfinUser('Alice', JF.alice);
      const response = await loginAs('alice');
      assert.strictEqual(response.status, 204);
      const links = await linksOf(alice.id);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].sub, 'sub-alice');
      assert.strictEqual(links[0].provider, 'test');
    });

    it('imports a Jellyfin-only user with default permissions', async function () {
      const response = await loginAs('jfonly');
      assert.strictEqual(response.status, 204);
      const user = await getRepository(User).findOneOrFail({
        where: { jellyfinUserId: JF.jfonly },
      });
      assert.strictEqual(user.userType, UserType.JELLYFIN);
      assert.strictEqual(user.jellyfinUsername, 'JfOnly');
      assert.strictEqual(user.permissions, Permission.REQUEST);
      assert.strictEqual((await linksOf(user.id))[0].sub, 'sub-jfonly');
    });

    it('links a Seerr administrator only when the username map lists it', async function () {
      const admin = await seerrJellyfinUser(
        'admin',
        JF.admin,
        Permission.ADMIN
      );
      getSettings().oidc.providers[0].jellyfinUsernameMap = {
        owner: 'admin',
      };
      const response = await loginAs('owner');
      assert.strictEqual(response.status, 204);
      assert.strictEqual((await linksOf(admin.id))[0].sub, 'sub-owner');
    });

    it('refuses an unmapped Seerr administrator', async function () {
      const admin = await seerrJellyfinUser(
        'admin',
        JF.admin,
        Permission.ADMIN
      );
      const response = await loginAs('admin');
      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.error, ApiErrorCode.Unauthorized);
      assert.strictEqual((await linksOf(admin.id)).length, 0);
    });

    it('refuses a name match when the user is linked to another identity', async function () {
      const alice = await seerrJellyfinUser('Alice', JF.alice);
      await getRepository(LinkedAccount).save(
        new LinkedAccount({
          user: alice,
          provider: 'test',
          sub: 'someone-else',
          username: 'someone',
        })
      );
      const response = await loginAs('alice');
      assert.strictEqual(response.status, 409);
      assert.strictEqual(
        response.body.error,
        ApiErrorCode.OidcAccountAlreadyLinked
      );
      assert.strictEqual((await linksOf(alice.id)).length, 1);
    });

    it('lets explicitly mapped identities share one account', async function () {
      const admin = await seerrJellyfinUser(
        'admin',
        JF.admin,
        Permission.ADMIN
      );
      getSettings().oidc.providers[0].jellyfinUsernameMap = {
        owner: 'admin',
        admin: 'admin',
      };
      assert.strictEqual((await loginAs('admin')).status, 204);
      fetchMock.hardReset();
      assert.strictEqual((await loginAs('owner')).status, 204);
      assert.strictEqual((await linksOf(admin.id)).length, 2);
    });

    it('skips users outside the auto-onboarding groups', async function () {
      const alice = await seerrJellyfinUser('Alice', JF.alice);
      const response = await loginAs('alice', { groups: ['vpn-users'] });
      assert.strictEqual(response.status, 403);
      assert.strictEqual(
        response.body.error,
        ApiErrorCode.OidcNoMatchingAccount
      );
      assert.strictEqual((await linksOf(alice.id)).length, 0);
      assert.strictEqual(getUsersMock.mock.callCount(), 0);
    });

    it('honours a custom group gate', async function () {
      await seerrJellyfinUser('Alice', JF.alice);
      getSettings().oidc.providers[0].autoOnboardGroups = ['media'];
      assert.strictEqual(
        (await loginAs('alice', { groups: ['media'] })).status,
        204
      );
    });

    it('skips logins without a verified e-mail', async function () {
      const alice = await seerrJellyfinUser('Alice', JF.alice);
      const response = await loginAs('alice', { email_verified: false });
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await linksOf(alice.id)).length, 0);
    });

    it('falls back to 403 when no Jellyfin user matches', async function () {
      const response = await loginAs('nobody');
      assert.strictEqual(response.status, 403);
      assert.strictEqual(
        response.body.error,
        ApiErrorCode.OidcNoMatchingAccount
      );
      assert.strictEqual(getUsersMock.mock.callCount(), 1);
      assert.strictEqual(
        await getRepository(User).count({ where: { email: 'nobody' } }),
        0
      );
    });

    it('ignores disabled Jellyfin users', async function () {
      const response = await loginAs('gone');
      assert.strictEqual(response.status, 403);
      assert.strictEqual(
        await getRepository(User).count({
          where: { jellyfinUserId: JF.disabled },
        }),
        0
      );
    });

    it('never matches by e-mail', async function () {
      const alice = await seerrJellyfinUser('Alice', JF.alice);
      const response = await loginAs('mallory', {
        email: 'alice@jellyfin.local',
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await linksOf(alice.id)).length, 0);
    });

    it('keeps upstream behaviour when the flag is off', async function () {
      const alice = await seerrJellyfinUser('Alice', JF.alice);
      getSettings().oidc.providers[0].autoOnboardJellyfin = false;
      const response = await loginAs('alice');
      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.error, ApiErrorCode.Unauthorized);
      assert.strictEqual((await linksOf(alice.id)).length, 0);
      assert.strictEqual(getUsersMock.mock.callCount(), 0);
    });
  });
});
