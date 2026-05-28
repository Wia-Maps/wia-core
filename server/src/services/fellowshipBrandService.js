import FellowshipBrand from '../models/FellowshipBrand.js';
import { logAdminActivity } from './adminActivityService.js';
import {
  deleteCloudinaryImage,
  getCloudinaryUploadLimitBytes,
  uploadCloudinaryImage,
} from './cloudinaryService.js';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeCode = (value) => toTrimmedString(value).toUpperCase();

const toActorRecord = (actor) => ({
  adminId: toTrimmedString(actor?.adminId) || null,
  email: toTrimmedString(actor?.email) || null,
});

const buildDisplayLogoUrl = (value) => {
  const normalizedValue = toTrimmedString(value);

  if (!normalizedValue) {
    return null;
  }

  if (!normalizedValue.includes('/upload/')) {
    return normalizedValue;
  }

  return normalizedValue.replace(
    '/upload/',
    '/upload/f_auto,q_auto,w_320,h_320,c_limit,dpr_auto/'
  );
};

const serializeFellowshipBrand = (entry) => {
  if (!entry) {
    return null;
  }

  return {
    code: normalizeCode(entry.code),
    name: toTrimmedString(entry.name) || null,
    contact: toTrimmedString(entry.contact) || null,
    logoUrl: buildDisplayLogoUrl(entry.logoUrl),
    mimeType: toTrimmedString(entry.mimeType) || null,
    updatedAt: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
  };
};

const formatByteLimitLabel = (byteCount) => {
  if (byteCount >= 1_000_000) {
    return `${(byteCount / 1_000_000).toFixed(1)} MB`;
  }

  if (byteCount >= 1000) {
    return `${Math.round(byteCount / 1000)} KB`;
  }

  return `${byteCount} bytes`;
};

const normalizeMimeType = (value) => {
  const normalized = toTrimmedString(value).toLowerCase();

  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }

  return normalized;
};

const parseImageDataUrl = (value) => {
  const normalizedValue = toTrimmedString(value);
  const match = normalizedValue.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);

  if (!match) {
    throw new Error('Upload must be a valid base64-encoded image.');
  }

  const mimeType = normalizeMimeType(match[1]);

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error('Only PNG, JPEG, WEBP, and SVG image uploads are supported.');
  }

  const base64Payload = match[2].replace(/\s+/g, '');
  const sizeBytes = Buffer.from(base64Payload, 'base64').length;

  if (!sizeBytes) {
    throw new Error('Uploaded image is empty.');
  }

  const uploadLimitBytes = getCloudinaryUploadLimitBytes();
  if (sizeBytes > uploadLimitBytes) {
    throw new Error(
      `Uploaded image must be smaller than ${formatByteLimitLabel(uploadLimitBytes)}.`
    );
  }

  return {
    mimeType,
    dataUrl: `data:${mimeType};base64,${base64Payload}`,
  };
};

const buildPublicIdSlug = (code) => {
  return (
    normalizeCode(code)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'fellowship'
  );
};

export const listFellowshipBrands = async () => {
  const items = await FellowshipBrand.find({}).sort({ code: 1 }).lean();
  return items.map((item) => serializeFellowshipBrand(item));
};

export const getFellowshipBrand = async (code) => {
  const normalizedCode = normalizeCode(code);

  if (!normalizedCode) {
    throw new Error('Fellowship code is required.');
  }

  const item = await FellowshipBrand.findOne({ code: normalizedCode }).lean();

  return serializeFellowshipBrand(item);
};

export const syncFellowshipBrandNames = async (entries, actor = null) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }

  const actorRecord = toActorRecord(actor);
  const pendingByCode = new Map();

  entries.forEach((entry) => {
    const code = normalizeCode(entry?.code);
    const name = toTrimmedString(entry?.name);
    const contact = toTrimmedString(entry?.contact);

    if (!code || !name || pendingByCode.has(code)) {
      return;
    }

    pendingByCode.set(code, { name, contact });
  });

  if (pendingByCode.size === 0) {
    return;
  }

  const codes = [...pendingByCode.keys()];
  const existingItems = await FellowshipBrand.find({ code: { $in: codes } }).lean();
  const existingByCode = new Map(existingItems.map((item) => [normalizeCode(item.code), item]));
  const updatedAt = new Date();
  const operations = [];

  pendingByCode.forEach((name, code) => {
    const payload = pendingByCode.get(code) ?? { name: '', contact: '' };
    const current = existingByCode.get(code);

    if (current && toTrimmedString(current.name) === payload.name && toTrimmedString(current.contact) === payload.contact) {
      return;
    }

    operations.push({
      updateOne: {
        filter: { code },
        update: {
          $set: {
            code,
            name: payload.name,
            contact: payload.contact || null,
            updatedAt,
            updatedBy: actorRecord,
          },
          $setOnInsert: {
            logoUrl: null,
            logoPublicId: null,
            mimeType: null,
          },
        },
        upsert: true,
      },
    });
  });

  if (operations.length > 0) {
    await FellowshipBrand.bulkWrite(operations);
  }
};

export const uploadFellowshipBrandLogo = async (code, input, actor = null) => {
  const normalizedCode = normalizeCode(code);

  if (!normalizedCode) {
    throw new Error('Fellowship code is required.');
  }

  const { mimeType, dataUrl } = parseImageDataUrl(input?.fileDataUrl ?? input?.imageDataUrl);
  const nextName = toTrimmedString(input?.name) || null;
  const nextContact = toTrimmedString(input?.contact) || null;
  const actorRecord = toActorRecord(actor);
  const existing = await FellowshipBrand.findOne({ code: normalizedCode });
  const uploadedLogo = await uploadCloudinaryImage({
    dataUrl,
    publicId: `${buildPublicIdSlug(normalizedCode)}-${Date.now()}`,
  });

  if (!uploadedLogo.secureUrl || !uploadedLogo.publicId) {
    throw new Error('Cloudinary did not return a usable logo URL.');
  }

  const updatedBrand = await FellowshipBrand.findOneAndUpdate(
    { code: normalizedCode },
    {
      $set: {
        code: normalizedCode,
        name: nextName || toTrimmedString(existing?.name) || null,
        contact: nextContact || toTrimmedString(existing?.contact) || null,
        logoUrl: uploadedLogo.secureUrl,
        logoPublicId: uploadedLogo.publicId,
        mimeType,
        updatedAt: new Date(),
        updatedBy: actorRecord,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  if (existing?.logoPublicId && existing.logoPublicId !== uploadedLogo.publicId) {
    try {
      await deleteCloudinaryImage(existing.logoPublicId);
    } catch (error) {
      console.warn(
        `Failed to delete replaced Cloudinary asset '${existing.logoPublicId}':`,
        error.message
      );
    }
  }

  const serializedBrand = serializeFellowshipBrand(updatedBrand?.toObject?.() ?? updatedBrand);

  await logAdminActivity({
    actionType: 'fellowship_brand_upload',
    actionLabel: 'Fellowship badge uploaded',
    targetType: 'fellowship_brand',
    targetId: normalizedCode,
    targetLabel: serializedBrand?.name || normalizedCode,
    details: `Uploaded a shared fellowship badge for '${normalizedCode}'.`,
    metadata: {
      code: normalizedCode,
      name: serializedBrand?.name ?? null,
      logoUrl: serializedBrand?.logoUrl ?? null,
      mimeType: serializedBrand?.mimeType ?? null,
    },
    actor,
  });

  return serializedBrand;
};

export const removeFellowshipBrandLogo = async (code, actor = null) => {
  const normalizedCode = normalizeCode(code);

  if (!normalizedCode) {
    throw new Error('Fellowship code is required.');
  }

  const existing = await FellowshipBrand.findOne({ code: normalizedCode });

  if (!existing) {
    throw new Error(`Fellowship brand '${normalizedCode}' was not found.`);
  }

  if (existing.logoPublicId) {
    try {
      await deleteCloudinaryImage(existing.logoPublicId);
    } catch (error) {
      console.warn(
        `Failed to delete Cloudinary asset '${existing.logoPublicId}':`,
        error.message
      );
    }
  }

  existing.logoUrl = null;
  existing.logoPublicId = null;
  existing.mimeType = null;
  existing.updatedAt = new Date();
  existing.updatedBy = toActorRecord(actor);
  await existing.save();

  const serializedBrand = serializeFellowshipBrand(existing.toObject());

  await logAdminActivity({
    actionType: 'fellowship_brand_remove',
    actionLabel: 'Fellowship badge removed',
    targetType: 'fellowship_brand',
    targetId: normalizedCode,
    targetLabel: serializedBrand?.name || normalizedCode,
    details: `Removed the shared fellowship badge for '${normalizedCode}'.`,
    metadata: {
      code: normalizedCode,
      name: serializedBrand?.name ?? null,
    },
    actor,
  });

  return serializedBrand;
};
