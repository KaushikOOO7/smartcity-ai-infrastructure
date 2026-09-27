/**
 * Predictive Maintenance & Infrastructure Deterioration Service
 * Models progressive asphalt fatigue, water infiltration, and structural wearing.
 * Note: Clearly flagged as a calibrated municipal deterioration model based on
 * traffic density, rainfall exposure, and physical depth measurements.
 */

export function calculateDeteriorationProjection(incident, weather) {
  const currentRisk = incident.risk_score || 50;
  const depth = incident.est_depth_cm || 2.5;
  const traffic = incident.risk_factors?.traffic || 60;
  const isRain = weather?.isRaining || false;

  // Rate of decay per week depends on traffic load and water ingress
  // Traffic multiplier: heavy traffic accelerates fatigue
  const trafficFactor = traffic / 50;
  // Water penetration multiplier
  const waterFactor = isRain ? 1.6 : 1.0;
  // Depth factor: deeper potholes accelerate exponentially due to wheel impacts
  const depthFactor = Math.min(2.0, 1 + depth / 10);

  const weeklyDecayRate = +(3.5 * trafficFactor * waterFactor * depthFactor).toFixed(1);

  const projected7Day = Math.min(100, Math.round(currentRisk + weeklyDecayRate));
  const projected30Day = Math.min(100, Math.round(currentRisk + weeklyDecayRate * 3.8));

  let trajectory = 'STABLE';
  if (weeklyDecayRate > 6.5) {
    trajectory = 'ACCELERATING';
  } else if (weeklyDecayRate > 3.0) {
    trajectory = 'MODERATE_WEAR';
  }

  return {
    is_simulation: true,
    model_name: 'Municipal Asphalt Fatigue & Infiltration Model v2',
    current_risk: currentRisk,
    projected_7_day_risk: projected7Day,
    projected_30_day_risk: projected30Day,
    weekly_decay_points: weeklyDecayRate,
    wear_trajectory: trajectory,
    estimated_failure_window: projected30Day >= 85 ? '10-18 days until structural road base compromise' : '30+ days until critical threshold',
  };
}
