import {
  approveRouteCandidate,
  deleteRecordingDraft,
  getRouteCandidate,
  listRouteCandidates,
  rejectRouteCandidate,
  saveRecordingDraft,
  submitRecordingCandidate,
  updateRouteCandidate,
} from '../services/routeCandidateService.js';
import { ingestRouteTelemetryBatch } from '../services/routeTelemetryService.js';

const getActorFromRequest = (req) => ({
  adminId: typeof req.user?.adminId === 'string' ? req.user.adminId : null,
  email: typeof req.user?.email === 'string' ? req.user.email : null,
});

export const postRouteTelemetryBatch = async (req, res) => {
  try {
    const record = await ingestRouteTelemetryBatch(req.body);
    return res.status(202).json({
      success: true,
      data: record,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to ingest telemetry batch',
    });
  }
};

export const getAdminRouteCandidates = async (req, res) => {
  try {
    const data = await listRouteCandidates({
      campusId: req.query.campusId,
      status: req.query.status,
      source: req.query.source,
      search: req.query.search,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to load route candidates',
    });
  }
};

export const getAdminRouteCandidate = async (req, res) => {
  try {
    const data = await getRouteCandidate(req.params.candidateId);
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message || 'Unable to load route candidate',
    });
  }
};

export const updateAdminRouteCandidate = async (req, res) => {
  try {
    const data = await updateRouteCandidate(req.params.candidateId, req.body, getActorFromRequest(req));
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to update route candidate',
    });
  }
};

export const approveAdminRouteCandidate = async (req, res) => {
  try {
    const data = await approveRouteCandidate(req.params.candidateId, req.body, getActorFromRequest(req));
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to approve route candidate',
    });
  }
};

export const rejectAdminRouteCandidate = async (req, res) => {
  try {
    const data = await rejectRouteCandidate(req.params.candidateId, req.body, getActorFromRequest(req));
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to reject route candidate',
    });
  }
};

export const saveAdminRouteRecordingDraft = async (req, res) => {
  try {
    const data = await saveRecordingDraft(req.body, getActorFromRequest(req));
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to save route recording draft',
    });
  }
};

export const deleteAdminRouteRecordingDraft = async (req, res) => {
  try {
    const data = await deleteRecordingDraft(req.params.draftId, getActorFromRequest(req));
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to delete route recording draft',
    });
  }
};

export const submitAdminRouteRecording = async (req, res) => {
  try {
    const data = await submitRecordingCandidate(req.body, getActorFromRequest(req));
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to submit route recording',
    });
  }
};
