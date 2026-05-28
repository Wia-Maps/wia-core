import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const resolveFirebaseAdminConfig = () => {
  const projectId = toTrimmedString(process.env.FIREBASE_PROJECT_ID);
  const clientEmail = toTrimmedString(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = toTrimmedString(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
};

const firebaseAdminConfig = resolveFirebaseAdminConfig();
const firebaseMessagingConfigured = Boolean(firebaseAdminConfig);

if (firebaseMessagingConfigured && getApps().length === 0) {
  initializeApp({
    credential: cert(firebaseAdminConfig),
  });
}

export const isFirebaseMessagingConfigured = () => firebaseMessagingConfigured;

export const getFirebaseMessaging = () => {
  if (!firebaseMessagingConfigured) {
    return null;
  }

  return getMessaging();
};
