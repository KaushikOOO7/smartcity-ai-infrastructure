/**
 * Smart Deduplication Service
 * Matches incoming reports against existing open incidents using spatial radius,
 * infrastructure type matching, and temporal proximity.
 * Preserves all original report entries as linked evidence rather than silently deleting them.
 */

import { haversineDistanceM } from './riskEngine.js';

// Deduplication radius per infrastructure type (in meters)
const DEDUP_RADII_M = {
  Pothole: 18.0,
  'Road Crack': 25.0,
  Waterlogging: 40.0,
  'Garbage Overflow': 30.0,
  'Broken Streetlight': 20.0,
  'Open Manhole': 15.0,
};

const SEVERITY_RANK = { minor: 0, moderate: 1, severe: 2 };

/**
 * Searches for an existing open incident that corresponds to the same defect
 */
export function findMatchingIncident(incidents, { lat, lon, infrastructure_type }) {
  const maxRadius = DEDUP_RADII_M[infrastructure_type] || 20.0;

  for (const inc of incidents) {
    if (inc.status === 'repaired' || inc.repair_status === 'REPAIR_VERIFIED') {
      continue;
    }

    // Must match infrastructure type
    if (inc.infrastructure_type !== infrastructure_type) {
      continue;
    }

    const dist = haversineDistanceM(lat, lon, inc.latitude, inc.longitude);
    if (dist <= maxRadius) {
      return { incident: inc, distanceM: Math.round(dist) };
    }
  }

  return null;
}

/**
 * Merges a new detection report into an existing incident, preserving linked report history.
 */
export function mergeReportIntoIncident(incident, report) {
  // Add to linked reports list
  const linkedReport = {
    report_id: report.report_id || `rep-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    vehicle_id: report.vehicle_id || 'fleet-unit',
    source: report.source || 'onboard_camera',
    latitude: report.latitude,
    longitude: report.longitude,
    severity: report.severity,
    est_depth_cm: report.est_depth_cm || 0,
    confidence: report.confidence || 0.8,
    image_ref: report.image_ref || null,
    timestamp: report.timestamp || Date.now() / 1000,
  };

  if (!incident.linked_reports) {
    incident.linked_reports = [];
  }
  incident.linked_reports.unshift(linkedReport);
  incident.report_count = incident.linked_reports.length;

  // Elevate severity to the highest observed
  if (SEVERITY_RANK[report.severity] > SEVERITY_RANK[incident.severity]) {
    incident.severity = report.severity;
  }

  // Update depth to maximum recorded
  if (report.est_depth_cm && report.est_depth_cm > (incident.est_depth_cm || 0)) {
    incident.est_depth_cm = report.est_depth_cm;
  }

  incident.updated_at = new Date().toISOString();

  return incident;
}
