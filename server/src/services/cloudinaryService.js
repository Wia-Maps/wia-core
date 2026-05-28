import crypto from 'node:crypto';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const getCloudinaryConfig = (folderOverride = '') => {
  const cloudName = toTrimmedString(process.env.CLOUDINARY_CLOUD_NAME);
  const apiKey = toTrimmedString(process.env.CLOUDINARY_API_KEY);
  const apiSecret = toTrimmedString(process.env.CLOUDINARY_API_SECRET);
  const folder =
    toTrimmedString(folderOverride) ||
    toTrimmedString(process.env.CLOUDINARY_FELLOWSHIP_FOLDER) ||
    'wia/fellowships';

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
    );
  }

  return {
    cloudName,
    apiKey,
    apiSecret,
    folder,
  };
};

const buildSignature = (params, apiSecret) => {
  const signaturePayload = Object.entries(params)
    .filter(([, value]) => value !== null && typeof value !== 'undefined' && String(value).length > 0)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto.createHash('sha1').update(`${signaturePayload}${apiSecret}`).digest('hex');
};

const postCloudinaryForm = async (resourcePath, formData) => {
  const { cloudName } = getCloudinaryConfig();
  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourcePath}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    body: formData,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error?.message || payload?.error || 'Cloudinary request failed.'
    );
  }

  return payload;
};

export const getCloudinaryUploadLimitBytes = () => {
  const configuredLimit = Number.parseInt(
    toTrimmedString(process.env.CLOUDINARY_MAX_UPLOAD_BYTES),
    10
  );

  if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
    return configuredLimit;
  }

  return 2_000_000;
};

export const uploadCloudinaryImage = async ({ dataUrl, publicId, folder: folderOverride = '' }) => {
  const { apiKey, apiSecret, folder } = getCloudinaryConfig(folderOverride);
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureParams = {
    folder,
    public_id: publicId,
    overwrite: 'true',
    invalidate: 'true',
    timestamp: String(timestamp),
  };
  const signature = buildSignature(signatureParams, apiSecret);
  const formData = new FormData();

  formData.set('file', dataUrl);
  formData.set('folder', folder);
  formData.set('public_id', publicId);
  formData.set('overwrite', 'true');
  formData.set('invalidate', 'true');
  formData.set('timestamp', String(timestamp));
  formData.set('api_key', apiKey);
  formData.set('signature', signature);

  const payload = await postCloudinaryForm('image/upload', formData);

  return {
    secureUrl: toTrimmedString(payload?.secure_url),
    publicId: toTrimmedString(payload?.public_id),
  };
};

export const deleteCloudinaryImage = async (publicId) => {
  const normalizedPublicId = toTrimmedString(publicId);

  if (!normalizedPublicId) {
    return null;
  }

  const { apiKey, apiSecret } = getCloudinaryConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureParams = {
    invalidate: 'true',
    public_id: normalizedPublicId,
    timestamp: String(timestamp),
  };
  const signature = buildSignature(signatureParams, apiSecret);
  const formData = new FormData();

  formData.set('public_id', normalizedPublicId);
  formData.set('invalidate', 'true');
  formData.set('timestamp', String(timestamp));
  formData.set('api_key', apiKey);
  formData.set('signature', signature);

  const payload = await postCloudinaryForm('image/destroy', formData);

  return {
    result: toTrimmedString(payload?.result) || 'unknown',
  };
};
