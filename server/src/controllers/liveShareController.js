import { issueLiveShareSession, resolveLiveShare } from '../services/liveShareService.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');
const toFiniteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);

export const createLiveShareSession = async (req, res) => {
  try {
    const sessionId = toTrimmedString(req.body?.sessionId);
    const lat = toFiniteNumber(req.body?.lat);
    const lng = toFiniteNumber(req.body?.lng);
    const sos = req.body?.sos === true;
    const broadcasterToken = toTrimmedString(req.body?.broadcasterToken);

    if (!sessionId || Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({
        success: false,
        error: 'sessionId, lat, and lng are required.',
      });
    }

    const data = issueLiveShareSession({
      sessionId,
      lat,
      lng,
      sos,
      broadcasterToken: broadcasterToken || null,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to create live-share session.',
    });
  }
};

export const resolveLiveShareSession = async (req, res) => {
  try {
    const liveToken = toTrimmedString(req.body?.liveToken);

    if (!liveToken) {
      return res.status(400).json({
        success: false,
        error: 'liveToken is required.',
      });
    }

    const data = resolveLiveShare(liveToken);
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to resolve live-share session.',
    });
  }
};
