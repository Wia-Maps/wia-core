import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import MapDataset from '../models/MapDataset.js';
import MapDatasetRevision from '../models/MapDatasetRevision.js';
import { logAdminActivity } from './adminActivityService.js';
import { validateRoutingGraph } from './routingGraphValidator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATASET_TYPES = ['locations', 'routing'];

const DEFAULT_DATASET_PATHS = {
  locations: [path.resolve(__dirname, '../../public/data/sample.geojson')],
  routing: [
    path.resolve(__dirname, '../../public/data/campus-routing.geojson'),
    path.resolve(__dirname, '../../public/data/campus-routing-mock.geojson'),
  ],
};

const seedPromises = new Map();
const DEFAULT_IMPORTED_LOCATION_TYPE = 'Location';
const ROUTING_EDGE_FROM_KEYS = ['from', 'from_id', 'from_node', 'source'];
const ROUTING_EDGE_TO_KEYS = ['to', 'to_id', 'to_node', 'target'];

const asRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value;
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const toTrimmedString = (value) => {
  return typeof value === 'string' ? value.trim() : '';
};

const toDatasetType = (value) => {
  return DATASET_TYPES.includes(value) ? value : null;
};

const isBundleType = (value) => {
  return typeof value === 'string' && value.trim() === 'wia-dataset-bundle';
};

const toFeatureId = (feature) => {
  if (typeof feature?.id === 'string') {
    const trimmed = feature.id.trim();
    return trimmed.length > 0 ? trimmed : '';
  }

  if (typeof feature?.id === 'number' && Number.isFinite(feature.id)) {
    return String(feature.id);
  }

  return '';
};

const readTrimmedProperty = (record, keys) => {
  const source = asRecord(record);
  if (!source) {
    return '';
  }

  for (const key of keys) {
    const value = toTrimmedString(source[key]);
    if (value) {
      return value;
    }
  }

  return '';
};

const normalizeIncomingFeature = (feature) => {
  const candidate = cloneJson(feature);

  if (!candidate || typeof candidate !== 'object' || candidate.type !== 'Feature') {
    throw new Error('Each feature must be a valid GeoJSON Feature.');
  }

  const featureId = toFeatureId(candidate);
  if (!featureId) {
    throw new Error('Each feature must include a non-empty id.');
  }

  if (!candidate.geometry || typeof candidate.geometry !== 'object') {
    throw new Error(`Feature '${featureId}' must include a geometry.`);
  }

  candidate.id = featureId;
  candidate.properties = asRecord(candidate.properties) ?? {};
  return candidate;
};

const normalizePartialFeatureCollection = (input) => {
  const collection = cloneJson(input);

  if (!collection || typeof collection !== 'object' || collection.type !== 'FeatureCollection') {
    throw new Error('Payload must be a GeoJSON FeatureCollection.');
  }

  if (!Array.isArray(collection.features)) {
    throw new Error('GeoJSON FeatureCollection must contain a features array.');
  }

  const seenIds = new Set();
  const features = collection.features.map((feature) => {
    const normalizedFeature = normalizeIncomingFeature(feature);

    if (seenIds.has(normalizedFeature.id)) {
      throw new Error(`Duplicate feature id '${normalizedFeature.id}' found in upload.`);
    }

    seenIds.add(normalizedFeature.id);
    return normalizedFeature;
  });

  return {
    ...collection,
    features,
  };
};

const normalizeDatasetBundle = (input) => {
  const candidate = cloneJson(input);
  const bundle = asRecord(candidate);

  if (!bundle || (!isBundleType(bundle.type) && (!('locations' in bundle) || !('routing' in bundle)))) {
    throw new Error('Bundle upload must contain both locations and routing FeatureCollections.');
  }

  return {
    type: 'wia-dataset-bundle',
    version: typeof bundle.version === 'number' && Number.isFinite(bundle.version) ? bundle.version : 1,
    locations: normalizePartialFeatureCollection(bundle.locations),
    routing: normalizePartialFeatureCollection(bundle.routing),
  };
};

const stampLocationFeature = (feature) => {
  const normalizedFeature = normalizeIncomingFeature(feature);
  return {
    ...normalizedFeature,
    properties: {
      ...normalizedFeature.properties,
      last_updated: Date.now(),
    },
  };
};

const mergeIndependentLocationProperties = (existingFeature, nextFeature) => {
  const existingProperties = asRecord(existingFeature?.properties) ?? {};
  const nextProperties = asRecord(nextFeature?.properties) ?? {};

  const mergedProperties = {
    ...nextProperties,
  };

  if (
    Object.prototype.hasOwnProperty.call(existingProperties, 'fellowships') &&
    !Object.prototype.hasOwnProperty.call(nextProperties, 'fellowships')
  ) {
    mergedProperties.fellowships = cloneJson(existingProperties.fellowships);
  }

  return {
    ...nextFeature,
    properties: mergedProperties,
  };
};

const normalizeLocationImportOptions = (input) => {
  const options = asRecord(input);
  const typeSourceProperty = toTrimmedString(options?.typeSourceProperty);
  const requestedFallback = toTrimmedString(options?.typeFallback);

  return {
    typeSourceProperty:
      typeSourceProperty && typeSourceProperty !== 'type' ? typeSourceProperty : null,
    typeFallback: requestedFallback || DEFAULT_IMPORTED_LOCATION_TYPE,
  };
};

const applyLocationImportOptions = (collection, inputOptions) => {
  const options = normalizeLocationImportOptions(inputOptions);
  let mappedFromSourceCount = 0;
  let fallbackCount = 0;

  const nextCollection = {
    ...collection,
    features: collection.features.map((feature) => {
      const properties = asRecord(feature.properties) ?? {};
      const existingType = toTrimmedString(properties.type);

      if (existingType) {
        return {
          ...feature,
          properties: {
            ...properties,
            type: existingType,
          },
        };
      }

      const mappedType = options.typeSourceProperty
        ? toTrimmedString(properties[options.typeSourceProperty])
        : '';

      if (mappedType) {
        mappedFromSourceCount += 1;
        return {
          ...feature,
          properties: {
            ...properties,
            type: mappedType,
          },
        };
      }

      fallbackCount += 1;
      return {
        ...feature,
        properties: {
          ...properties,
          type: options.typeFallback,
        },
      };
    }),
  };

  return {
    collection: nextCollection,
    summary: {
      typeSourceProperty: options.typeSourceProperty,
      typeFallback: options.typeFallback,
      mappedFromSourceCount,
      fallbackCount,
    },
  };
};

const normalizeLocationCollection = (input) => {
  const collection = normalizePartialFeatureCollection(input);
  const errors = [];

  collection.features = collection.features.map((feature) => {
    const properties = asRecord(feature.properties) ?? {};
    const name = typeof properties.name === 'string' ? properties.name.trim() : '';
    const type = typeof properties.type === 'string' ? properties.type.trim() : '';

    if (!name) {
      errors.push(`Location feature '${feature.id}' is missing properties.name.`);
    }

    if (!type) {
      errors.push(`Location feature '${feature.id}' is missing properties.type.`);
    }

    return {
      ...feature,
      properties,
    };
  });

  return {
    collection,
    errors,
    warnings: [],
  };
};

const validateDatasetCollection = (datasetType, input, options = {}) => {
  if (datasetType === 'locations') {
    return normalizeLocationCollection(input);
  }

  const collection = normalizePartialFeatureCollection(input);
  const validation = validateRoutingGraph(collection, {
    strict: true,
    allowEmptyGraph: options.allowEmptyGraph === true,
  });

  return {
    collection,
    errors: validation.errors,
    warnings: validation.warnings,
  };
};

const summarizeRoutingDeleteConflicts = (collection, deletedIds) => {
  const deletedIdSet = new Set(
    (Array.isArray(deletedIds) ? deletedIds : [])
      .map((featureId) => (typeof featureId === 'string' ? featureId.trim() : ''))
      .filter(Boolean)
  );

  if (deletedIdSet.size === 0) {
    return [];
  }

  return collection.features.reduce((conflicts, feature) => {
    const featureId = toFeatureId(feature);
    if (!featureId || deletedIdSet.has(featureId)) {
      return conflicts;
    }

    const properties = asRecord(feature.properties) ?? {};
    const fromId = readTrimmedProperty(properties, ROUTING_EDGE_FROM_KEYS);
    const toId = readTrimmedProperty(properties, ROUTING_EDGE_TO_KEYS);
    const referencedNodeIds = [...new Set([fromId, toId].filter((nodeId) => deletedIdSet.has(nodeId)))];

    if (referencedNodeIds.length === 0) {
      return conflicts;
    }

    conflicts.push({
      edgeId: featureId,
      referencedNodeIds,
    });

    return conflicts;
  }, []);
};

const assertRoutingDeleteIntegrity = (collection, deletedIds) => {
  const conflicts = summarizeRoutingDeleteConflicts(collection, deletedIds);

  if (conflicts.length > 0) {
    const details = conflicts.slice(0, 5).map((conflict) => {
      const nodeList = conflict.referencedNodeIds.map((nodeId) => `'${nodeId}'`).join(', ');
      return `edge '${conflict.edgeId}' still references node(s) ${nodeList}`;
    });
    const suffix = conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : '';

    throw new Error(
      `Cannot delete routing feature(s) because ${details.join('; ')}${suffix}. Delete the dependent edge(s) in the same operation first.`
    );
  }

  const validation = validateDatasetCollection('routing', collection, { allowEmptyGraph: true });
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join(' '));
  }
};

const resolveSeedPaths = (datasetType) => {
  if (datasetType === 'locations') {
    const configuredPath = process.env.LOCATION_GEOJSON_PATH?.trim();
    return configuredPath ? [path.resolve(process.cwd(), configuredPath)] : DEFAULT_DATASET_PATHS.locations;
  }

  const configuredPrimary = process.env.ROUTING_GEOJSON_PATH?.trim();
  const configuredFallback = process.env.ROUTING_GEOJSON_FALLBACK_PATH?.trim();
  const resolved = [];

  if (configuredPrimary) {
    resolved.push(path.resolve(process.cwd(), configuredPrimary));
  }

  if (configuredFallback) {
    resolved.push(path.resolve(process.cwd(), configuredFallback));
  }

  return resolved.length > 0 ? resolved : DEFAULT_DATASET_PATHS.routing;
};

const loadSeedCollection = async (datasetType) => {
  const candidatePaths = resolveSeedPaths(datasetType);
  let lastError = null;

  for (const candidatePath of candidatePaths) {
    try {
      const rawValue = await readFile(candidatePath, 'utf8');
      const parsed = JSON.parse(rawValue);
      const validation = validateDatasetCollection(datasetType, parsed);

      if (validation.errors.length > 0) {
        lastError = new Error(validation.errors.join(' '));
        continue;
      }

      return validation.collection;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(`Unable to load ${datasetType} seed data.`);
};

const toDatasetResponse = (dataset) => {
  return {
    datasetType: dataset.datasetType,
    revisionId: dataset.revisionId,
    version: dataset.version,
    updatedAt: new Date(dataset.updatedAt).toISOString(),
    collection: cloneJson(dataset.collection),
  };
};

const toRevisionResponse = (revision) => {
  return {
    id: revision._id?.toString?.() ?? revision.id,
    datasetType: revision.datasetType,
    version: revision.version,
    featureCount: revision.featureCount,
    changeType: revision.changeType,
    changeSummary: revision.changeSummary,
    actor: revision.actor ?? null,
    sourceRevisionId: revision.sourceRevisionId ?? null,
    metadata: revision.metadata ?? null,
    createdAt: new Date(revision.createdAt).toISOString(),
  };
};

const publishDatasetRevision = async ({
  datasetType,
  collection,
  changeType,
  changeSummary,
  actor,
  sourceRevisionId = null,
  metadata = null,
  skipActivityLog = false,
  allowInvalidState = false,
  session = null,
}) => {
  const normalizedType = toDatasetType(datasetType);
  if (!normalizedType) {
    throw new Error(`Unsupported dataset type '${datasetType}'.`);
  }

  const validation = validateDatasetCollection(normalizedType, collection, {
    allowEmptyGraph: normalizedType === 'routing',
  });
  if (validation.errors.length > 0 && !allowInvalidState) {
    throw new Error(validation.errors.join(' '));
  }

  const revisionObjectId = new mongoose.Types.ObjectId();
  const createdAt = new Date();
  const version = revisionObjectId.toString();
  const featureCount = validation.collection.features.length;

  const revision = new MapDatasetRevision({
    _id: revisionObjectId,
    datasetType: normalizedType,
    version,
    featureCount,
    collection: validation.collection,
    changeType,
    changeSummary,
    actor: actor ?? { adminId: null, email: null },
    sourceRevisionId,
    metadata,
    createdAt,
  });

  await revision.save(session ? { session } : undefined);

  await MapDataset.findOneAndUpdate(
    { datasetType: normalizedType },
    {
      datasetType: normalizedType,
      revisionId: version,
      version,
      updatedAt: createdAt,
      featureCount,
      collection: validation.collection,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    }
  );

  if (!skipActivityLog && changeType !== 'seed') {
    await logAdminActivity({
      actionType: changeType === 'restore' ? 'dataset_restore' : 'dataset_publish',
      actionLabel: changeType === 'restore' ? 'Dataset restore' : 'Dataset publish',
      targetType: 'dataset',
      targetId: normalizedType,
      targetLabel: `${normalizedType} dataset`,
      details: changeSummary,
      metadata: {
        datasetType: normalizedType,
        revisionId: version,
        changeType,
        ...(asRecord(metadata) ?? {}),
      },
      actor: toActorRecord(actor),
      createdAt,
      session,
    });
  }

  return {
    dataset: {
      datasetType: normalizedType,
      revisionId: version,
      version,
      updatedAt: createdAt,
      featureCount,
      collection: validation.collection,
    },
    revision: revision.toObject(),
    warnings: validation.warnings,
  };
};

export const ensureDatasetSeeded = async (datasetType) => {
  const normalizedType = toDatasetType(datasetType);
  if (!normalizedType) {
    throw new Error(`Unsupported dataset type '${datasetType}'.`);
  }

  const existing = await MapDataset.findOne({ datasetType: normalizedType }).lean();
  if (existing) {
    return existing;
  }

  const activeSeedPromise = seedPromises.get(normalizedType);
  if (activeSeedPromise) {
    return activeSeedPromise;
  }

  const seedPromise = (async () => {
    const current = await MapDataset.findOne({ datasetType: normalizedType }).lean();
    if (current) {
      return current;
    }

    const collection = await loadSeedCollection(normalizedType);
    const seeded = await publishDatasetRevision({
      datasetType: normalizedType,
      collection,
      changeType: 'seed',
      changeSummary: 'Seeded live dataset from bundled fixture.',
      actor: {
        adminId: null,
        email: 'system',
      },
      metadata: {
        source: 'seed-fixture',
      },
    });

    return seeded.dataset;
  })().finally(() => {
    seedPromises.delete(normalizedType);
  });

  seedPromises.set(normalizedType, seedPromise);
  return seedPromise;
};

export const ensureAllMapDatasetsSeeded = async () => {
  await Promise.all(DATASET_TYPES.map((datasetType) => ensureDatasetSeeded(datasetType)));
};

export const getCurrentDataset = async (datasetType) => {
  const normalizedType = toDatasetType(datasetType);
  if (!normalizedType) {
    throw new Error(`Unsupported dataset type '${datasetType}'.`);
  }

  await ensureDatasetSeeded(normalizedType);
  const dataset = await MapDataset.findOne({ datasetType: normalizedType }).lean();

  if (!dataset) {
    throw new Error(`No live ${normalizedType} dataset found.`);
  }

  return dataset;
};

export const getDatasetResponse = async (datasetType) => {
  const dataset = await getCurrentDataset(datasetType);
  return toDatasetResponse(dataset);
};

export const listDatasetRevisions = async (datasetType, limit = 25) => {
  const normalizedType = toDatasetType(datasetType);
  if (!normalizedType) {
    throw new Error(`Unsupported dataset type '${datasetType}'.`);
  }

  await ensureDatasetSeeded(normalizedType);

  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  const revisions = await MapDatasetRevision.find({ datasetType: normalizedType })
    .sort({ createdAt: -1, _id: -1 })
    .limit(safeLimit)
    .lean();

  return revisions.map((revision) => toRevisionResponse(revision));
};

const updateCollectionWithFeatures = ({
  currentCollection,
  nextFeatures,
  nextMetadata,
}) => {
  const candidate = cloneJson(currentCollection);
  candidate.features = nextFeatures;

  if (typeof nextMetadata !== 'undefined') {
    if (nextMetadata === null) {
      delete candidate.metadata;
    } else {
      candidate.metadata = nextMetadata;
    }
  }

  return candidate;
};

const getFeatureIndex = (collection, featureId) => {
  return collection.features.findIndex((feature) => toFeatureId(feature) === featureId);
};

const mergeCollectionMetadata = (currentCollection, incomingCollection) => {
  const currentMetadata = asRecord(currentCollection.metadata);
  const incomingMetadata = asRecord(incomingCollection.metadata);

  if (!incomingMetadata) {
    return typeof currentCollection.metadata === 'undefined' ? undefined : cloneJson(currentCollection.metadata);
  }

  return {
    ...(currentMetadata ?? {}),
    ...incomingMetadata,
  };
};

const toActorRecord = (actor) => {
  return {
    adminId: actor?.adminId ?? null,
    email: actor?.email ?? null,
  };
};

export const createFeatureInDataset = async (datasetType, feature, actor, options = {}) => {
  const current = await getCurrentDataset(datasetType);
  const nextFeature = datasetType === 'locations' ? stampLocationFeature(feature) : normalizeIncomingFeature(feature);
  const featureId = nextFeature.id;

  if (getFeatureIndex(current.collection, featureId) !== -1) {
    throw new Error(`Feature '${featureId}' already exists.`);
  }

  const nextCollection = updateCollectionWithFeatures({
    currentCollection: current.collection,
    nextFeatures: [...current.collection.features, nextFeature],
  });

  return publishDatasetRevision({
    datasetType,
    collection: nextCollection,
    changeType: 'create_feature',
    changeSummary: `Created feature '${featureId}'.`,
    actor: toActorRecord(actor),
    sourceRevisionId: current.revisionId,
    metadata: {
      featureId,
    },
    skipActivityLog: options.skipActivityLog === true,
  });
};

export const updateFeatureInDataset = async (datasetType, featureId, feature, actor, options = {}) => {
  const current = await getCurrentDataset(datasetType);
  const existingIndex = getFeatureIndex(current.collection, featureId);

  if (existingIndex === -1) {
    throw new Error(`Feature '${featureId}' was not found.`);
  }

  const nextFeature = datasetType === 'locations' ? stampLocationFeature(feature) : normalizeIncomingFeature(feature);
  const nextFeatureId = nextFeature.id;

  if (nextFeatureId !== featureId) {
    const conflictingIndex = getFeatureIndex(current.collection, nextFeatureId);
    if (conflictingIndex !== -1 && conflictingIndex !== existingIndex) {
      throw new Error(`Cannot rename feature to '${nextFeatureId}' because it already exists.`);
    }
  }

  const nextFeatures = [...current.collection.features];
  nextFeatures.splice(existingIndex, 1, nextFeature);

  const nextCollection = updateCollectionWithFeatures({
    currentCollection: current.collection,
    nextFeatures,
  });

  return publishDatasetRevision({
    datasetType,
    collection: nextCollection,
    changeType: 'update_feature',
    changeSummary:
      nextFeatureId === featureId
        ? `Updated feature '${featureId}'.`
        : `Renamed feature '${featureId}' to '${nextFeatureId}'.`,
    actor: toActorRecord(actor),
    sourceRevisionId: current.revisionId,
    metadata: {
      previousFeatureId: featureId,
      featureId: nextFeatureId,
    },
    skipActivityLog: options.skipActivityLog === true,
  });
};

export const deleteFeatureFromDataset = async (datasetType, featureId, actor, options = {}) => {
  const current = await getCurrentDataset(datasetType);
  const existingIndex = getFeatureIndex(current.collection, featureId);

  if (existingIndex === -1) {
    throw new Error(`Feature '${featureId}' was not found.`);
  }

  const nextFeatures = current.collection.features.filter((feature) => toFeatureId(feature) !== featureId);
  const nextCollection = updateCollectionWithFeatures({
    currentCollection: current.collection,
    nextFeatures,
  });

  if (datasetType === 'routing') {
    assertRoutingDeleteIntegrity(nextCollection, [featureId]);
  }

  return publishDatasetRevision({
    datasetType,
    collection: nextCollection,
    changeType: 'delete_feature',
    changeSummary: `Deleted feature '${featureId}'.`,
    actor: toActorRecord(actor),
    sourceRevisionId: current.revisionId,
    metadata: {
      featureId,
    },
    skipActivityLog: options.skipActivityLog === true,
    allowInvalidState: datasetType === 'locations',
  });
};

export const bulkUpsertDatasetFeatures = async (datasetType, inputCollection, actor, options = {}) => {
  const current = await getCurrentDataset(datasetType);
  const partialCollection = normalizePartialFeatureCollection(inputCollection);
  const importPreparation =
    datasetType === 'locations'
      ? applyLocationImportOptions(partialCollection, options.importOptions)
      : { collection: partialCollection, summary: null };
  const preparedCollection = importPreparation.collection;
  const nextFeaturesById = new Map(
    current.collection.features.map((feature) => [toFeatureId(feature), cloneJson(feature)])
  );

  let createdCount = 0;
  let updatedCount = 0;

  preparedCollection.features.forEach((feature) => {
    const normalizedNextFeature =
      datasetType === 'locations' ? stampLocationFeature(feature) : normalizeIncomingFeature(feature);
    const existingFeature = nextFeaturesById.get(normalizedNextFeature.id);
    const nextFeature =
      datasetType === 'locations' && existingFeature
        ? mergeIndependentLocationProperties(existingFeature, normalizedNextFeature)
        : normalizedNextFeature;
    const featureId = nextFeature.id;

    if (nextFeaturesById.has(featureId)) {
      updatedCount += 1;
    } else {
      createdCount += 1;
    }

    nextFeaturesById.set(featureId, nextFeature);
  });

  const nextCollection = updateCollectionWithFeatures({
    currentCollection: current.collection,
    nextFeatures: Array.from(nextFeaturesById.values()),
    nextMetadata: mergeCollectionMetadata(current.collection, preparedCollection),
  });

  return publishDatasetRevision({
    datasetType,
    collection: nextCollection,
    changeType: 'bulk_upsert',
    changeSummary: `Bulk upserted ${preparedCollection.features.length} feature(s): ${createdCount} created, ${updatedCount} updated.`,
    actor: toActorRecord(actor),
    sourceRevisionId: current.revisionId,
    metadata: {
      uploadedFeatureCount: preparedCollection.features.length,
      createdCount,
      updatedCount,
      ...(importPreparation.summary
        ? {
            importOptions: {
              typeSourceProperty: importPreparation.summary.typeSourceProperty,
              typeFallback: importPreparation.summary.typeFallback,
            },
            importSummary: {
              mappedFromSourceCount: importPreparation.summary.mappedFromSourceCount,
              fallbackCount: importPreparation.summary.fallbackCount,
            },
          }
        : {}),
    },
    skipActivityLog: options.skipActivityLog === true,
  });
};

export const bulkImportDatasetBundle = async (inputBundle, actor, options = {}) => {
  const normalizedBundle = normalizeDatasetBundle(inputBundle);
  const [currentLocations, currentRouting] = await Promise.all([
    getCurrentDataset('locations'),
    getCurrentDataset('routing'),
  ]);

  const locationsPreparation = (() => {
    const partialCollection = normalizePartialFeatureCollection(normalizedBundle.locations);
    return applyLocationImportOptions(partialCollection, options.importOptions);
  })();
  const routingPreparation = {
    collection: normalizePartialFeatureCollection(normalizedBundle.routing),
  };

  const locationValidation = validateDatasetCollection('locations', locationsPreparation.collection);
  if (locationValidation.errors.length > 0) {
    throw new Error(locationValidation.errors.join(' '));
  }

  const routingValidation = validateDatasetCollection('routing', routingPreparation.collection, {
    allowEmptyGraph: true,
  });
  if (routingValidation.errors.length > 0) {
    throw new Error(routingValidation.errors.join(' '));
  }

  const buildNextCollection = (datasetType, currentDataset, preparedCollection) => {
    const nextFeaturesById = new Map(
      currentDataset.collection.features.map((feature) => [toFeatureId(feature), cloneJson(feature)])
    );

    let createdCount = 0;
    let updatedCount = 0;

    preparedCollection.features.forEach((feature) => {
      const normalizedNextFeature =
        datasetType === 'locations' ? stampLocationFeature(feature) : normalizeIncomingFeature(feature);
      const existingFeature = nextFeaturesById.get(normalizedNextFeature.id);
      const nextFeature =
        datasetType === 'locations' && existingFeature
          ? mergeIndependentLocationProperties(existingFeature, normalizedNextFeature)
          : normalizedNextFeature;
      const featureId = nextFeature.id;

      if (nextFeaturesById.has(featureId)) {
        updatedCount += 1;
      } else {
        createdCount += 1;
      }

      nextFeaturesById.set(featureId, nextFeature);
    });

    return {
      nextCollection: updateCollectionWithFeatures({
        currentCollection: currentDataset.collection,
        nextFeatures: Array.from(nextFeaturesById.values()),
        nextMetadata: mergeCollectionMetadata(currentDataset.collection, preparedCollection),
      }),
      createdCount,
      updatedCount,
      uploadedFeatureCount: preparedCollection.features.length,
    };
  };

  const nextLocations = buildNextCollection('locations', currentLocations, locationsPreparation.collection);
  const nextRouting = buildNextCollection('routing', currentRouting, routingPreparation.collection);

  const session = await mongoose.startSession();
  let locationsResult = null;
  let routingResult = null;

  try {
    await session.withTransaction(async () => {
      locationsResult = await publishDatasetRevision({
        datasetType: 'locations',
        collection: nextLocations.nextCollection,
        changeType: 'bulk_upsert',
        changeSummary: `Bundle import upserted ${nextLocations.uploadedFeatureCount} location feature(s): ${nextLocations.createdCount} created, ${nextLocations.updatedCount} updated.`,
        actor: toActorRecord(actor),
        sourceRevisionId: currentLocations.revisionId,
        metadata: {
          uploadedFeatureCount: nextLocations.uploadedFeatureCount,
          createdCount: nextLocations.createdCount,
          updatedCount: nextLocations.updatedCount,
          bundleImport: true,
          importOptions: {
            typeSourceProperty: locationsPreparation.summary.typeSourceProperty,
            typeFallback: locationsPreparation.summary.typeFallback,
          },
          importSummary: {
            mappedFromSourceCount: locationsPreparation.summary.mappedFromSourceCount,
            fallbackCount: locationsPreparation.summary.fallbackCount,
          },
        },
        session,
      });

      routingResult = await publishDatasetRevision({
        datasetType: 'routing',
        collection: nextRouting.nextCollection,
        changeType: 'bulk_upsert',
        changeSummary: `Bundle import upserted ${nextRouting.uploadedFeatureCount} routing feature(s): ${nextRouting.createdCount} created, ${nextRouting.updatedCount} updated.`,
        actor: toActorRecord(actor),
        sourceRevisionId: currentRouting.revisionId,
        metadata: {
          uploadedFeatureCount: nextRouting.uploadedFeatureCount,
          createdCount: nextRouting.createdCount,
          updatedCount: nextRouting.updatedCount,
          bundleImport: true,
        },
        session,
      });
    });
  } finally {
    await session.endSession();
  }

  return {
    locations: locationsResult,
    routing: routingResult,
  };
};

export const bulkDeleteDatasetFeatures = async (datasetType, featureIds, actor, options = {}) => {
  const current = await getCurrentDataset(datasetType);
  const normalizedIds = [...new Set(
    (Array.isArray(featureIds) ? featureIds : [])
      .map((featureId) => (typeof featureId === 'string' ? featureId.trim() : ''))
      .filter(Boolean)
  )];

  if (normalizedIds.length === 0) {
    throw new Error('At least one feature id is required for bulk delete.');
  }

  const nextFeatures = current.collection.features.filter((feature) => !normalizedIds.includes(toFeatureId(feature)));
  const deletedCount = current.collection.features.length - nextFeatures.length;

  if (deletedCount === 0) {
    throw new Error('None of the selected features were found.');
  }

  const nextCollection = updateCollectionWithFeatures({
    currentCollection: current.collection,
    nextFeatures,
  });

  if (datasetType === 'routing') {
    assertRoutingDeleteIntegrity(nextCollection, normalizedIds);
  }

  return publishDatasetRevision({
    datasetType,
    collection: nextCollection,
    changeType: 'bulk_delete',
    changeSummary: `Deleted ${deletedCount} feature(s) in bulk.`,
    actor: toActorRecord(actor),
    sourceRevisionId: current.revisionId,
    metadata: {
      featureIds: normalizedIds,
      deletedCount,
    },
    skipActivityLog: options.skipActivityLog === true,
    allowInvalidState: datasetType === 'locations',
  });
};

export const restoreDatasetRevision = async (datasetType, revisionId, actor, options = {}) => {
  const normalizedType = toDatasetType(datasetType);
  if (!normalizedType) {
    throw new Error(`Unsupported dataset type '${datasetType}'.`);
  }

  await ensureDatasetSeeded(normalizedType);

  const targetRevision = await MapDatasetRevision.findById(revisionId).lean();
  if (!targetRevision || targetRevision.datasetType !== normalizedType) {
    throw new Error(`Revision '${revisionId}' was not found for ${normalizedType}.`);
  }

  const current = await getCurrentDataset(normalizedType);

  return publishDatasetRevision({
    datasetType: normalizedType,
    collection: targetRevision.collection,
    changeType: 'restore',
    changeSummary: `Restored revision '${revisionId}'.`,
    actor: toActorRecord(actor),
    sourceRevisionId: current.revisionId,
    metadata: {
      restoredRevisionId: revisionId,
    },
    skipActivityLog: options.skipActivityLog === true,
  });
};

const toLocationRecord = (feature) => {
  const properties = asRecord(feature?.properties) ?? {};
  const locationId = toFeatureId(feature);
  const name = typeof properties.name === 'string' ? properties.name.trim() : '';
  const type = typeof properties.type === 'string' ? properties.type.trim() : 'Location';
  const shortCode = typeof properties.short_code === 'string' ? properties.short_code.trim() : null;
  const campusId = typeof properties.campus_id === 'string' ? properties.campus_id.trim() : null;
  const powerUpdateLocked = properties.power_update_locked === true;

  if (!locationId || !name) {
    return null;
  }

  return {
    locationId,
    name,
    type,
    shortCode,
    campusId,
    powerUpdateLocked,
  };
};

export const listLocationCatalogRecords = async () => {
  const dataset = await getCurrentDataset('locations');

  return dataset.collection.features
    .map((feature) => toLocationRecord(feature))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
};

export const parseDatasetTypeParam = (value) => {
  const normalizedType = toDatasetType(value);
  if (!normalizedType) {
    throw new Error(`Unsupported dataset type '${value}'.`);
  }

  return normalizedType;
};

export const formatDatasetMutationResponse = (result) => {
  return {
    dataset: toDatasetResponse(result.dataset),
    revision: toRevisionResponse(result.revision),
    warnings: result.warnings ?? [],
  };
};

export const formatDatasetBundleMutationResponse = (result) => {
  return {
    locations: formatDatasetMutationResponse(result.locations),
    routing: formatDatasetMutationResponse(result.routing),
  };
};
