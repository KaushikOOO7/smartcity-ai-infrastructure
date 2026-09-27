/**
 * Smart Team Dispatch Engine
 * Recommends optimal municipal work crews based on geographical proximity,
 * trade specialization matching the infrastructure defect, active queue workload,
 * and equipment readiness.
 */

import { haversineDistanceM } from './riskEngine.js';

// Defect type to required specialization mapping
export const TYPE_SPECIALIZATION_MAP = {
  Pothole: 'Asphalt & Road Surface',
  'Road Crack': 'Asphalt & Road Surface',
  Waterlogging: 'Drainage & Stormwater',
  'Garbage Overflow': 'Sanitation & Solid Waste',
  'Broken Streetlight': 'Electrical & Illumination',
  'Open Manhole': 'Sewer & Underground Civil',
};

// Travel speed model in city traffic: ~25 km/h = ~416 meters per minute
const AVERAGE_SPEED_METERS_PER_MIN = 400;

export function calculateETA(distanceMeters) {
  // Base travel time + 3 min mobilization buffer
  const minutes = Math.max(3, Math.round(distanceMeters / AVERAGE_SPEED_METERS_PER_MIN) + 3);
  return `${minutes} min`;
}

/**
 * Evaluates all teams for an incident and returns ranked recommendations.
 */
export function recommendTeamForIncident(incident, teams) {
  const targetSpecialization = TYPE_SPECIALIZATION_MAP[incident.infrastructure_type] || 'General Maintenance';

  const scoredTeams = teams.map((team) => {
    const distM = haversineDistanceM(
      incident.latitude,
      incident.longitude,
      team.latitude,
      team.longitude
    );
    const distKm = +(distM / 1000).toFixed(1);
    const eta = calculateETA(distM);

    // Scoring factors (0 - 100)
    let score = 100;

    // 1. Specialization Match (40 pts)
    const isSpecialist = team.specialization.toLowerCase() === targetSpecialization.toLowerCase();
    if (isSpecialist) {
      score += 40;
    } else {
      score -= 30; // Mismatch penalty
    }

    // 2. Availability (30 pts)
    if (team.availability === 'AVAILABLE') {
      score += 30;
    } else if (team.availability === 'EN_ROUTE') {
      score += 10;
    } else if (team.availability === 'ON_SITE') {
      score -= 20;
    } else {
      score -= 40; // BUSY / OFF_DUTY
    }

    // 3. Proximity (20 pts)
    // Closer is better
    const distancePenalty = Math.min(25, distKm * 3);
    score -= distancePenalty;

    // 4. Current Workload (10 pts)
    const workloadPenalty = (team.current_workload || 0) * 8;
    score -= workloadPenalty;

    return {
      team_id: team.team_id,
      name: team.name,
      specialization: team.specialization,
      availability: team.availability,
      current_workload: team.current_workload || 0,
      required_equipment: team.equipment,
      distance_km: distKm,
      distance_m: Math.round(distM),
      eta,
      fit_score: Math.max(0, Math.round(score)),
      is_specialist: isSpecialist,
    };
  });

  // Sort by fit score descending
  scoredTeams.sort((a, b) => b.fit_score - a.fit_score);

  const top = scoredTeams[0] || null;

  return {
    recommended_team: top,
    candidate_teams: scoredTeams,
  };
}
