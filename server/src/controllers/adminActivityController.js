import { listAdminActivities } from '../services/adminActivityService.js';
import { revertAdminActivity } from '../services/adminActivityRevertService.js';
import { formatDatasetMutationResponse } from '../services/mapDatasetService.js';

const getActorFromRequest = (req) => ({
  adminId: typeof req.user?.adminId === 'string' ? req.user.adminId : null,
  email: typeof req.user?.email === 'string' ? req.user.email : null,
});

export const getAdminActivity = async (req, res) => {
  try {
    const data = await listAdminActivities({
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      actionType: req.query.actionType,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to load admin activity',
    });
  }
};

export const revertAdminActivityState = async (req, res) => {
  try {
    const result = await revertAdminActivity(req.params.activityId, getActorFromRequest(req));

    return res.status(200).json({
      success: true,
      data: {
        kind: result.kind,
        message: result.message,
        affectedCount: result.affectedCount ?? null,
        datasetMutation: result.kind === 'dataset' && result.mutation ? formatDatasetMutationResponse(result.mutation) : null,
      },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to restore activity state',
    });
  }
};
