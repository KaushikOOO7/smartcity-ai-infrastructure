/**
 * Weather Context Integration Service
 * Manages current weather conditions and provides rain-adjusted risk multipliers.
 */

let currentWeatherState = {
  condition: 'Scattered Clouds',
  isRaining: false,
  rainIntensity: 'none', // 'none' | 'light' | 'heavy'
  temperatureC: 28,
  humidityPercent: 78,
  windSpeedKmh: 14,
  floodRiskLevel: 'LOW',
  lastUpdated: new Date().toISOString(),
};

export function getCurrentWeather() {
  return currentWeatherState;
}

export function setWeatherCondition(preset) {
  if (preset === 'heavy_rain') {
    currentWeatherState = {
      condition: 'Monsoon Heavy Downpour',
      isRaining: true,
      rainIntensity: 'heavy',
      temperatureC: 24,
      humidityPercent: 94,
      windSpeedKmh: 38,
      floodRiskLevel: 'HIGH',
      lastUpdated: new Date().toISOString(),
    };
  } else if (preset === 'light_rain') {
    currentWeatherState = {
      condition: 'Passing Showers',
      isRaining: true,
      rainIntensity: 'light',
      temperatureC: 26,
      humidityPercent: 86,
      windSpeedKmh: 20,
      floodRiskLevel: 'MODERATE',
      lastUpdated: new Date().toISOString(),
    };
  } else {
    currentWeatherState = {
      condition: 'Clear / Part Sunny',
      isRaining: false,
      rainIntensity: 'none',
      temperatureC: 29,
      humidityPercent: 68,
      windSpeedKmh: 12,
      floodRiskLevel: 'LOW',
      lastUpdated: new Date().toISOString(),
    };
  }
  return currentWeatherState;
}
