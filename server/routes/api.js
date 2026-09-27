/**
 * Complete REST API Router for SmartCity AI
 * Bridges legacy pothole reporting endpoints and advanced infrastructure management.
 */

import express from 'express';
import crypto from 'crypto';
import { incidents, teams } from '../db.js';
import { calculateRiskScore } from '../services/riskEngine.js';
import { verifyDetection } from '../services/verificationEngine.js';
import { findMatchingIncident, mergeReportIntoIncident } from '../services/dedupEngine.js';
import { recommendTeamForIncident, calculateETA } from '../services/dispatchEngine.js';
import { verifyRepairCompletion } from '../services/repairEngine.js';
import { calculateDeteriorationProjection } from '../services/predictiveEngine.js';
import { getCurrentWeather, setWeatherCondition } from '../services/weatherService.js';
import { queryAssistant } from '../services/assistantEngine.js';
import { runInferenceOnFrame } from '../services/visionInference.js';
import { updateTracks, resetTracks } from '../services/videoTracker.js';

export const apiRouter = express.Router();

// ---------------------------------------------------------------------------
// 1. LEGACY ENDPOINTS (Preserves 100% working compatibility)
// ---------------------------------------------------------------------------

// POST /api/detections
apiRouter.post('/detections', (req, res) => {
  const data = req.body || {};
  const required = ['vehicle_id', 'latitude', 'longitude', 'severity'];
  const missing = required.filter((f) => !(f in data));
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const lat = parseFloat(data.latitude);
  const lon = parseFloat(data.longitude);
  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'latitude/longitude must be numeric' });
  }

  const weather = getCurrentWeather();
  const infraType = data.infrastructure_type || 'Pothole';

  // Check smart deduplication against existing open incidents
  const match = findMatchingIncident(incidents, { lat, lon, infrastructure_type: infraType });

  if (match) {
    const mergedIncident = mergeReportIntoIncident(match.incident, {
      vehicle_id: data.vehicle_id,
      latitude: lat,
      longitude: lon,
      severity: data.severity,
      est_depth_cm: parseFloat(data.est_depth_cm) || 0,
      confidence: parseFloat(data.confidence) || 0.85,
      image_ref: data.image_ref || null,
      timestamp: Date.now() / 1000,
    });

    // Re-evaluate risk with new complaint count
    const riskAnalysis = calculateRiskScore({
      severity: mergedIncident.severity,
      infrastructure_type: mergedIncident.infrastructure_type,
      est_depth_cm: mergedIncident.est_depth_cm,
      traffic_density: mergedIncident.risk_factors?.traffic || 75,
      pedestrian_exposure: mergedIncident.risk_factors?.pedestrian || 60,
      report_count: mergedIncident.report_count,
      lat,
      lon,
      weather,
    });

    mergedIncident.risk_score = riskAnalysis.risk_score;
    mergedIncident.priority = riskAnalysis.priority;
    mergedIncident.risk_factors = riskAnalysis.factors;
    mergedIncident.deterioration_projection = calculateDeteriorationProjection(mergedIncident, weather);

    return res.status(200).json({
      merged: true,
      detection: mergedIncident,
    });
  }

  // Otherwise, create new incident
  const newId = 1000 + incidents.length + 1;
  const verification = verifyDetection({
    confidence: parseFloat(data.confidence) || 0.86,
    frameCount: data.frameCount || 4,
    temporalConsistency: data.temporalConsistency || 0.88,
    est_depth_cm: parseFloat(data.est_depth_cm) || 3.0,
  });

  const riskAnalysis = calculateRiskScore({
    severity: data.severity,
    infrastructure_type: infraType,
    est_depth_cm: parseFloat(data.est_depth_cm) || 3.0,
    traffic_density: 70,
    pedestrian_exposure: 55,
    report_count: 1,
    lat,
    lon,
    weather,
  });

  const nowIso = new Date().toISOString();
  const slaHours = riskAnalysis.priority === 'CRITICAL' ? 4 : riskAnalysis.priority === 'HIGH' ? 12 : 24;

  const newIncident = {
    id: String(newId),
    incident_id: newId,
    infrastructure_type: infraType,
    latitude: lat,
    longitude: lon,
    address: data.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    detection_confidence: parseFloat(data.confidence) || 0.86,
    severity: data.severity,
    est_depth_cm: parseFloat(data.est_depth_cm) || 3.0,
    risk_score: riskAnalysis.risk_score,
    priority: riskAnalysis.priority,
    risk_factors: riskAnalysis.factors,
    location_context: riskAnalysis.location_context,
    source: data.source || `Onboard Camera (${data.vehicle_id})`,
    image_evidence: data.image_ref || 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?w=600&auto=format&fit=crop&q=80',
    after_image_evidence: null,
    created_at: nowIso,
    updated_at: nowIso,
    status: 'reported',
    assigned_team: null,
    estimated_response_time: 'Pending Dispatch',
    sla_hours: slaHours,
    sla_deadline: new Date(Date.now() + slaHours * 3600 * 1000).toISOString(),
    verification_status: verification.verification_status,
    verification_score: verification.verification_score,
    verification_reason: verification.verification_reason,
    repair_status: 'PENDING',
    report_count: 1,
    linked_reports: [
      {
        report_id: `rep-${newId}-1`,
        vehicle_id: data.vehicle_id,
        source: 'onboard_camera',
        latitude: lat,
        longitude: lon,
        severity: data.severity,
        est_depth_cm: parseFloat(data.est_depth_cm) || 3.0,
        confidence: parseFloat(data.confidence) || 0.86,
        timestamp: Date.now() / 1000,
      },
    ],
    timestamp: Date.now() / 1000,
  };

  newIncident.deterioration_projection = calculateDeteriorationProjection(newIncident, weather);

  incidents.unshift(newIncident);

  return res.status(201).json({
    merged: false,
    detection: newIncident,
  });
});

// GET /api/detections
apiRouter.get('/detections', (req, res) => {
  const { severity, status, limit = 200, offset = 0 } = req.query;
  let filtered = incidents;

  if (severity) {
    filtered = filtered.filter((d) => d.severity === severity);
  }
  if (status) {
    filtered = filtered.filter((d) => d.status === status);
  }

  const sorted = [...filtered].sort((a, b) => b.timestamp - a.timestamp);
  const paginated = sorted.slice(Number(offset), Number(offset) + Number(limit));

  return res.json(paginated);
});

// GET /api/detections/:id
apiRouter.get('/detections/:id', (req, res) => {
  const item = incidents.find((d) => String(d.id) === req.params.id || String(d.incident_id) === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  return res.json(item);
});

// PATCH /api/detections/:id
apiRouter.patch('/detections/:id', (req, res) => {
  const item = incidents.find((d) => String(d.id) === req.params.id || String(d.incident_id) === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });

  if (req.body.status) item.status = req.body.status;
  if (req.body.priority) item.priority = req.body.priority;
  item.updated_at = new Date().toISOString();

  return res.json(item);
});

// GET /api/stats
apiRouter.get('/stats', (req, res) => {
  const total = incidents.length;
  const openReports = incidents.filter((d) => d.status !== 'repaired');
  const vehicles = new Set();
  incidents.forEach((i) => {
    i.linked_reports?.forEach((r) => vehicles.add(r.vehicle_id));
  });

  const openBySeverity = { minor: 0, moderate: 0, severe: 0 };
  openReports.forEach((d) => {
    if (d.severity in openBySeverity) openBySeverity[d.severity]++;
  });

  const byStatus = {};
  incidents.forEach((d) => {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  });

  return res.json({
    total_reports: total,
    active_vehicles: vehicles.size || 5,
    open_by_severity: openBySeverity,
    by_status: byStatus,
  });
});

// GET /api/health
apiRouter.get('/health', (req, res) => {
  return res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// 2. EXTENDED SMARTCITY AI ENDPOINTS
// ---------------------------------------------------------------------------

// GET /api/incidents - Rich query & filter support
apiRouter.get('/incidents', (req, res) => {
  const {
    priority,
    infrastructure_type,
    status,
    verification_status,
    search,
    sort = 'risk_score',
  } = req.query;

  let filtered = [...incidents];

  if (priority && priority !== 'all') {
    filtered = filtered.filter((i) => i.priority === priority);
  }
  if (infrastructure_type && infrastructure_type !== 'all') {
    filtered = filtered.filter((i) => i.infrastructure_type === infrastructure_type);
  }
  if (status && status !== 'all') {
    filtered = filtered.filter((i) => i.status === status);
  }
  if (verification_status && verification_status !== 'all') {
    filtered = filtered.filter((i) => i.verification_status === verification_status);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (i) =>
        String(i.incident_id).includes(q) ||
        (i.address && i.address.toLowerCase().includes(q)) ||
        i.infrastructure_type.toLowerCase().includes(q)
    );
  }

  // Sorting
  if (sort === 'risk_score') {
    filtered.sort((a, b) => b.risk_score - a.risk_score);
  } else if (sort === 'newest') {
    filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  } else if (sort === 'sla_urgency') {
    filtered.sort((a, b) => new Date(a.sla_deadline).getTime() - new Date(b.sla_deadline).getTime());
  }

  return res.json(filtered);
});

// GET /api/incidents/:id
apiRouter.get('/incidents/:id', (req, res) => {
  const item = incidents.find(
    (i) => String(i.id) === req.params.id || String(i.incident_id) === req.params.id
  );
  if (!item) return res.status(404).json({ error: 'Incident not found' });
  return res.json(item);
});

// GET /api/incidents/:id/recommend-team - Recommendation Engine
apiRouter.get('/incidents/:id/recommend-team', (req, res) => {
  const item = incidents.find(
    (i) => String(i.id) === req.params.id || String(i.incident_id) === req.params.id
  );
  if (!item) return res.status(404).json({ error: 'Incident not found' });

  const result = recommendTeamForIncident(item, teams);
  return res.json(result);
});

// POST /api/incidents/:id/assign - Assign work crew
apiRouter.post('/incidents/:id/assign', (req, res) => {
  const item = incidents.find(
    (i) => String(i.id) === req.params.id || String(i.incident_id) === req.params.id
  );
  if (!item) return res.status(404).json({ error: 'Incident not found' });

  const { team_id } = req.body;
  const team = teams.find((t) => t.team_id === team_id);
  if (!team) return res.status(400).json({ error: 'Selected team does not exist' });

  // Update previous team if needed
  if (item.assigned_team && item.assigned_team.team_id) {
    const oldTeam = teams.find((t) => t.team_id === item.assigned_team.team_id);
    if (oldTeam && oldTeam.current_workload > 0) {
      oldTeam.current_workload--;
      if (oldTeam.current_workload === 0) oldTeam.availability = 'AVAILABLE';
    }
  }

  // Increment workload on new team
  team.current_workload = (team.current_workload || 0) + 1;
  team.availability = team.current_workload >= 3 ? 'BUSY' : 'EN_ROUTE';

  const recommendation = recommendTeamForIncident(item, [team]);
  const eta = recommendation.candidate_teams[0]?.eta || '12 min';

  item.assigned_team = {
    team_id: team.team_id,
    name: team.name,
    specialization: team.specialization,
    eta,
    assigned_at: new Date().toISOString(),
  };
  item.estimated_response_time = eta;
  item.status = 'scheduled';
  item.repair_status = 'IN_PROGRESS';
  item.updated_at = new Date().toISOString();

  return res.json({ success: true, incident: item, team });
});

// POST /api/incidents/:id/verify-repair - Closed loop repair verification
apiRouter.post('/incidents/:id/verify-repair', (req, res) => {
  const item = incidents.find(
    (i) => String(i.id) === req.params.id || String(i.incident_id) === req.params.id
  );
  if (!item) return res.status(404).json({ error: 'Incident not found' });

  const { afterImageRef, technicianNotes, qualityCheckSimulated = 'auto' } = req.body;

  const result = verifyRepairCompletion({
    incident: item,
    afterImageRef,
    technicianNotes,
    qualityCheckSimulated,
  });

  item.repair_status = result.repair_status;
  item.status = result.incident_status;
  item.repair_verification = {
    verified: result.success,
    score: result.verification_score,
    reason: result.reason,
    verified_at: result.verified_at,
  };
  if (afterImageRef) {
    item.after_image_evidence = afterImageRef;
  }
  item.updated_at = new Date().toISOString();

  // If successfully closed, relieve team workload
  if (result.success && item.assigned_team) {
    const team = teams.find((t) => t.team_id === item.assigned_team.team_id);
    if (team && team.current_workload > 0) {
      team.current_workload--;
      if (team.current_workload === 0) team.availability = 'AVAILABLE';
    }
  }

  return res.json({ success: result.success, result, incident: item });
});

// GET /api/teams - Work crew roster
apiRouter.get('/teams', (req, res) => {
  return res.json(teams);
});

// GET /api/teams/:id
apiRouter.get('/teams/:id', (req, res) => {
  const team = teams.find((t) => t.team_id === req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  // Get active assignments
  const activeIncidents = incidents.filter(
    (i) => i.assigned_team?.team_id === team.team_id && i.status !== 'repaired'
  );

  return res.json({ ...team, active_incidents: activeIncidents });
});

// GET /api/weather & POST /api/weather
apiRouter.get('/weather', (req, res) => {
  return res.json(getCurrentWeather());
});

apiRouter.post('/weather', (req, res) => {
  const { preset } = req.body || {};
  const updated = setWeatherCondition(preset);

  // Recalculate risks for all open incidents with updated weather
  for (const inc of incidents) {
    if (inc.status !== 'repaired') {
      const riskAnalysis = calculateRiskScore({
        severity: inc.severity,
        infrastructure_type: inc.infrastructure_type,
        est_depth_cm: inc.est_depth_cm,
        traffic_density: inc.risk_factors?.traffic || 70,
        pedestrian_exposure: inc.risk_factors?.pedestrian || 60,
        report_count: inc.report_count || 1,
        lat: inc.latitude,
        lon: inc.longitude,
        weather: updated,
      });
      inc.risk_score = riskAnalysis.risk_score;
      inc.priority = riskAnalysis.priority;
      inc.risk_factors = riskAnalysis.factors;
      inc.deterioration_projection = calculateDeteriorationProjection(inc, updated);
    }
  }

  return res.json({ success: true, weather: updated });
});

// GET /api/analytics
apiRouter.get('/analytics', (req, res) => {
  const total = incidents.length;
  const resolved = incidents.filter((i) => i.status === 'repaired' || i.repair_status === 'REPAIR_VERIFIED').length;
  const critical = incidents.filter((i) => i.priority === 'CRITICAL' && i.status !== 'repaired').length;
  const pendingDispatch = incidents.filter((i) => !i.assigned_team && i.status !== 'repaired').length;

  const byType = {};
  const byPriority = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byStatus = {};

  incidents.forEach((i) => {
    byType[i.infrastructure_type] = (byType[i.infrastructure_type] || 0) + 1;
    byPriority[i.priority] = (byPriority[i.priority] || 0) + 1;
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
  });

  const avgResponseTimeMin = 18; // Average dispatched response time
  const resolutionRatePercent = total > 0 ? Math.round((resolved / total) * 100) : 0;

  return res.json({
    kpis: {
      active_incidents: total - resolved,
      critical_issues: critical,
      pending_dispatch: pendingDispatch,
      in_progress: incidents.filter((i) => i.status === 'in_progress').length,
      resolved_today: resolved,
      resolution_rate: `${resolutionRatePercent}%`,
      average_response_time: `${avgResponseTimeMin} min`,
    },
    by_type: byType,
    by_priority: byPriority,
    by_status: byStatus,
    teams_summary: {
      total: teams.length,
      available: teams.filter((t) => t.availability === 'AVAILABLE').length,
      busy: teams.filter((t) => t.availability === 'BUSY').length,
      en_route: teams.filter((t) => t.availability === 'EN_ROUTE').length,
    },
  });
});

// POST /api/assistant/query - Grounded AI Assistant Q&A
apiRouter.post('/assistant/query', (req, res) => {
  const { question } = req.body || {};
  const weather = getCurrentWeather();
  const result = queryAssistant({ question, incidents, teams, weather });
  return res.json(result);
});

// POST /api/simulate/fleet - Triggers simulated vehicle detection or citizen report
apiRouter.post('/simulate/fleet', (req, res) => {
  const sampleDefects = [
    { type: 'Pothole', severity: 'severe', depth: 6.8, address: 'MG Road Junction' },
    { type: 'Pothole', severity: 'moderate', depth: 3.4, address: 'Pattom Palace Road' },
    { type: 'Road Crack', severity: 'moderate', depth: 2.1, address: 'Bypass NH 66 Corridor' },
    { type: 'Waterlogging', severity: 'severe', depth: 22.0, address: 'Thampanoor Flyover Underpass' },
    { type: 'Open Manhole', severity: 'severe', depth: 70.0, address: 'Palayam University Library Road' },
    { type: 'Garbage Overflow', severity: 'moderate', depth: 0, address: 'Kovalam Tourist Corridor' },
    { type: 'Broken Streetlight', severity: 'minor', depth: 0, address: 'Technopark Main Boulevard' },
  ];

  const pick = sampleDefects[Math.floor(Math.random() * sampleDefects.length)];
  const isDuplicateTest = Math.random() < 0.6; // 60% chance to test duplicate merging on an existing hotspot

  let lat, lon;
  if (isDuplicateTest && incidents.length > 0) {
    const existing = incidents[Math.floor(Math.random() * Math.min(3, incidents.length))];
    const degPerM = 1 / 111000;
    lat = existing.latitude + (Math.random() - 0.5) * 8 * degPerM;
    lon = existing.longitude + (Math.random() - 0.5) * 8 * degPerM;
    pick.type = existing.infrastructure_type;
  } else {
    lat = 8.48 + Math.random() * (8.56 - 8.48);
    lon = 76.91 + Math.random() * (76.97 - 76.91);
  }

  const vehicles = ['bus-042', 'bus-017', 'car-104', 'car-118', 'drone-survey', 'citizen-portal'];
  const vehicle = vehicles[Math.floor(Math.random() * vehicles.length)];

  // Forward into detection processor
  req.body = {
    vehicle_id: vehicle,
    latitude: lat,
    longitude: lon,
    infrastructure_type: pick.type,
    severity: pick.severity,
    est_depth_cm: pick.depth,
    confidence: +(0.84 + Math.random() * 0.14).toFixed(2),
    address: pick.address,
    frameCount: 4,
    temporalConsistency: 0.91,
  };

  // Delegate directly to detections handler
  return apiRouter.handle(req, res);
});

// ---------------------------------------------------------------------------
// 3. LIVE AI CAMERA COMPUTER VISION ENDPOINTS
// ---------------------------------------------------------------------------

// GET /api/detection/model-status
apiRouter.get('/detection/model-status', (req, res) => {
  return res.json({
    status: 'ONLINE',
    model_name: 'YOLOv8-Stereo-Pothole-v1.4',
    supported_classes: ['Pothole'],
    multiclass_extensible: true,
    supported_inputs: ['webcam', 'ip_camera', 'uploaded_video'],
    inference_pipeline: 'Real-time Road ROI Luminance & Gradient Morphology + Disparity Depth',
    weights_path: 'detection/detect_pothole.py',
  });
});

// POST /api/detection/infer-frame
apiRouter.post('/detection/infer-frame', async (req, res) => {
  try {
    const { frameData, lat = null, lon = null, address = null, autoTrack = true } = req.body || {};

    if (!frameData) {
      return res.status(400).json({ error: 'Missing frameData (base64 image)' });
    }

    const inferenceResult = await runInferenceOnFrame(frameData);

    if (!inferenceResult.success) {
      return res.status(422).json(inferenceResult);
    }

    let trackedObjects = [];
    if (autoTrack && inferenceResult.detections.length > 0) {
      trackedObjects = updateTracks(inferenceResult.detections, {
        lat,
        lon,
        address,
        evidenceImage: frameData,
      });
    }

    return res.json({
      success: true,
      model: inferenceResult.model,
      latency_ms: inferenceResult.latency_ms,
      frame_dimensions: { width: inferenceResult.frame_width, height: inferenceResult.frame_height },
      detections: inferenceResult.detections,
      tracked_objects: trackedObjects,
    });
  } catch (err) {
    console.error('Frame inference error:', err);
    return res.status(500).json({ error: 'Internal inference error', details: err.message });
  }
});

// POST /api/detection/capture-incident
apiRouter.post('/detection/capture-incident', (req, res) => {
  try {
    const {
      frameData,
      detection,
      lat = null,
      lon = null,
      address = null,
    } = req.body || {};

    const weather = getCurrentWeather();
    const infraType = detection?.class || detection?.infrastructure_type || 'Pothole';
    const severity = detection?.severity || 'moderate';
    const estDepthCm = detection?.est_depth_cm || 3.5;
    const confidence = detection?.confidence || 0.88;

    const finalLat = (lat !== null && !isNaN(Number(lat))) ? Number(lat) : +(8.5068 + (Math.random() - 0.5) * 0.006).toFixed(5);
    const finalLon = (lon !== null && !isNaN(Number(lon))) ? Number(lon) : +(76.9525 + (Math.random() - 0.5) * 0.006).toFixed(5);
    const finalAddress = address || 'MG Road Central (Live AI Operator Capture)';

    const riskAnalysis = calculateRiskScore({
      severity,
      infrastructure_type: infraType,
      est_depth_cm: estDepthCm,
      traffic_density: 80,
      pedestrian_exposure: 65,
      report_count: 1,
      lat: finalLat,
      lon: finalLon,
      weather,
    });

    const newId = 1000 + incidents.length + 1;
    const nowIso = new Date().toISOString();
    const slaHours = riskAnalysis.priority === 'CRITICAL' ? 4 : riskAnalysis.priority === 'HIGH' ? 12 : 24;

    const newIncident = {
      id: String(newId),
      incident_id: newId,
      infrastructure_type: infraType,
      latitude: finalLat,
      longitude: finalLon,
      address: finalAddress,
      detection_confidence: confidence,
      severity,
      est_depth_cm: estDepthCm,
      risk_score: riskAnalysis.risk_score,
      priority: riskAnalysis.priority,
      risk_factors: riskAnalysis.factors,
      location_context: riskAnalysis.location_context,
      source: 'Live Camera Capture & Manual Verification',
      image_evidence: frameData || 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?w=600&auto=format&fit=crop&q=80',
      after_image_evidence: null,
      created_at: nowIso,
      updated_at: nowIso,
      status: 'reported',
      assigned_team: null,
      estimated_response_time: 'Pending Dispatch',
      sla_hours: slaHours,
      sla_deadline: new Date(Date.now() + slaHours * 3600 * 1000).toISOString(),
      verification_status: 'VERIFIED',
      verification_score: Math.round(confidence * 100),
      verification_reason: `Operator manual capture verified from live video stream with ${Math.round(confidence * 100)}% model confidence.`,
      repair_status: 'PENDING',
      report_count: 1,
      linked_reports: [
        {
          report_id: `cap-${newId}`,
          vehicle_id: 'operator-camera-capture',
          source: 'live_camera_yolo',
          latitude: lat,
          longitude: lon,
          severity,
          est_depth_cm: estDepthCm,
          confidence,
          timestamp: Date.now() / 1000,
        },
      ],
      timestamp: Date.now() / 1000,
    };

    newIncident.deterioration_projection = calculateDeteriorationProjection(newIncident, weather);
    incidents.unshift(newIncident);

    return res.status(201).json({
      success: true,
      message: `Incident #${newId} created`,
      incident: newIncident,
    });
  } catch (err) {
    console.error('Capture incident error:', err);
    return res.status(500).json({ error: 'Failed to capture incident', details: err.message });
  }
});

// POST /api/detection/reset-tracker
apiRouter.post('/detection/reset-tracker', (req, res) => {
  resetTracks();
  return res.json({ success: true, message: 'Object tracker reset' });
});

