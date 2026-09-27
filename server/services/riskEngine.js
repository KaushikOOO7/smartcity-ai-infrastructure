/**
 * Dynamic Risk Engine for Municipal Infrastructure Incidents
 * Calculates a transparent 0-100 risk score with configurable weighted factors.
 */

export const RISK_WEIGHTS = {
  severity: 0.30,
  traffic: 0.25,
  pedestrian: 0.15,
  location: 0.15,
  complaints: 0.10,
  weather: 0.05,
};

// Municipal POIs for Critical Location Awareness
export const CRITICAL_POIS = [
  { name: 'Government General Hospital', type: 'hospital', lat: 8.5042, lon: 76.9485, radiusM: 400, criticality: 95 },
  { name: 'Central Railway Station', type: 'railway_station', lat: 8.4875, lon: 76.9532, radiusM: 350, criticality: 90 },
  { name: 'City Central Bus Terminal', type: 'bus_stop', lat: 8.4890, lon: 76.9510, radiusM: 300, criticality: 88 },
  { name: 'Model High School & College', type: 'school', lat: 8.5020, lon: 76.9560, radiusM: 300, criticality: 92 },
  { name: 'National Highway NH 66 Corridor', type: 'highway', lat: 8.5459, lon: 76.9109, radiusM: 500, criticality: 85 },
  { name: 'Thiruvananthapuram International Airport Access', type: 'airport', lat: 8.5090, lon: 76.9200, radiusM: 600, criticality: 86 },
  { name: 'District Fire & Emergency Services', type: 'emergency_facility', lat: 8.4980, lon: 76.9420, radiusM: 400, criticality: 94 },
];

export function haversineDistanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function findNearestCriticalPOI(lat, lon) {
  let nearest = null;
  let minDistance = Infinity;

  for (const poi of CRITICAL_POIS) {
    const dist = haversineDistanceM(lat, lon, poi.lat, poi.lon);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = { ...poi, distanceM: Math.round(dist) };
    }
  }

  return nearest;
}

/**
 * Calculates raw factor scores and overall risk score (0-100)
 */
export function calculateRiskScore(params) {
  const {
    severity = 'moderate',
    infrastructure_type = 'Pothole',
    est_depth_cm = 3.0,
    traffic_density = 70, // 0 - 100
    pedestrian_exposure = 60, // 0 - 100
    report_count = 1,
    lat,
    lon,
    weather = { isRaining: false, rainIntensity: 'none' }, // 'none' | 'light' | 'heavy'
  } = params;

  // 1. Defect Severity Factor (0 - 100)
  let severityScore = 50;
  if (severity === 'severe') severityScore = 90;
  else if (severity === 'moderate') severityScore = 65;
  else if (severity === 'minor') severityScore = 35;

  // Type specific severity amplifier
  if (infrastructure_type === 'Open Manhole') {
    severityScore = Math.min(100, severityScore + 20); // Life safety hazard
  } else if (infrastructure_type === 'Waterlogging' && weather.isRaining) {
    severityScore = Math.min(100, severityScore + 15);
  } else if (est_depth_cm > 6) {
    severityScore = Math.min(100, severityScore + 10);
  }

  // 2. Traffic Density Factor (0 - 100)
  const trafficScore = Math.min(100, Math.max(0, traffic_density));

  // 3. Pedestrian Exposure Factor (0 - 100)
  const pedestrianScore = Math.min(100, Math.max(0, pedestrian_exposure));

  // 4. Location Criticality Factor (0 - 100)
  let locationScore = 40;
  let nearbyPOI = null;
  if (lat && lon) {
    nearbyPOI = findNearestCriticalPOI(lat, lon);
    if (nearbyPOI && nearbyPOI.distanceM <= nearbyPOI.radiusM) {
      // Proximity falloff
      const ratio = 1 - nearbyPOI.distanceM / nearbyPOI.radiusM;
      locationScore = Math.round(50 + (nearbyPOI.criticality - 50) * ratio);
    } else if (nearbyPOI && nearbyPOI.distanceM <= 1000) {
      locationScore = Math.round(50 + 20 * (1 - nearbyPOI.distanceM / 1000));
    }
  }

  // 5. Complaint Frequency / Duplicate Factor (0 - 100)
  // 1 report = 20, 2 reports = 45, 3 = 65, 5+ = 90+
  const complaintsScore = Math.min(100, Math.round(20 + Math.log2(Math.max(1, report_count)) * 25));

  // 6. Weather & Flood Risk Factor (0 - 100)
  let weatherScore = 20;
  if (weather.rainIntensity === 'heavy') {
    weatherScore = 90;
  } else if (weather.rainIntensity === 'light') {
    weatherScore = 60;
  } else if (weather.isRaining) {
    weatherScore = 50;
  }

  // Waterlogging / road cracks / open manholes are exponentially worse in rain
  if (weather.isRaining && ['Waterlogging', 'Open Manhole', 'Pothole'].includes(infrastructure_type)) {
    weatherScore = Math.min(100, weatherScore + 15);
  }

  // Weighted Composite Risk Score
  const rawRisk =
    severityScore * RISK_WEIGHTS.severity +
    trafficScore * RISK_WEIGHTS.traffic +
    pedestrianScore * RISK_WEIGHTS.pedestrian +
    locationScore * RISK_WEIGHTS.location +
    complaintsScore * RISK_WEIGHTS.complaints +
    weatherScore * RISK_WEIGHTS.weather;

  const riskScore = Math.min(100, Math.max(1, Math.round(rawRisk)));

  // Priority classification
  let priority = 'LOW';
  if (riskScore >= 80) priority = 'CRITICAL';
  else if (riskScore >= 65) priority = 'HIGH';
  else if (riskScore >= 45) priority = 'MEDIUM';

  // Critical Location Explanation
  let locationReason = 'Standard municipal sector';
  if (nearbyPOI && nearbyPOI.distanceM <= nearbyPOI.radiusM) {
    locationReason = `High priority partly because incident is within ${nearbyPOI.distanceM}m of ${nearbyPOI.name} (${nearbyPOI.type.replace('_', ' ')}).`;
  } else if (nearbyPOI && nearbyPOI.distanceM <= 800) {
    locationReason = `Located within ${nearbyPOI.distanceM}m of critical transit/facility: ${nearbyPOI.name}.`;
  }

  return {
    risk_score: riskScore,
    priority,
    factors: {
      severity: severityScore,
      traffic: trafficScore,
      pedestrian: pedestrianScore,
      location: locationScore,
      complaints: complaintsScore,
      weather: weatherScore,
    },
    weights: RISK_WEIGHTS,
    location_context: {
      nearest_poi: nearbyPOI,
      explanation: locationReason,
    },
  };
}
