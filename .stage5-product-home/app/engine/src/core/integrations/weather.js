/**
 * Ecowitt Weather Station Integration
 * Connects to your weather station via Ecowitt cloud API
 */

/**
 * Fetch realtime weather data from Ecowitt station
 * @param {Object} integrationConfig - Config from family_integrations table
 * @returns {Promise<Object>} Weather data
 */
async function fetchWeatherData(integrationConfig) {
  const { application_key, api_key, mac } = integrationConfig;
  
  const url = new URL('https://api.ecowitt.net/api/v3/device/real_time');
  url.searchParams.append('application_key', application_key);
  url.searchParams.append('api_key', api_key);
  url.searchParams.append('mac', mac);
  url.searchParams.append('call_back', 'all');

  try {
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(`Weather API returned error code: ${data.code}`);
    }

    // Extract and format key weather data
    const weatherData = data.data;
    
    return {
      outdoor: {
        temperature: weatherData.outdoor?.temperature?.value,
        feelsLike: weatherData.outdoor?.feels_like?.value,
        humidity: weatherData.outdoor?.humidity?.value,
      },
      wind: {
        speed: weatherData.wind?.wind_speed?.value,
        gust: weatherData.wind?.wind_gust?.value,
        direction: weatherData.wind?.wind_direction?.value,
      },
      pressure: {
        relative: weatherData.pressure?.relative?.value,
      },
      solar: {
        uv: weatherData.solar_and_uvi?.uvi?.value,
        radiation: weatherData.solar_and_uvi?.solar?.value,
      },
      indoor: {
        temperature: weatherData.indoor?.temperature?.value,
        humidity: weatherData.indoor?.humidity?.value,
      },
      lastUpdate: new Date().toISOString(),
      rawData: weatherData,
    };
  } catch (error) {
    console.error('Weather API fetch failed:', error);
    throw error;
  }
}

module.exports = {
  fetchWeatherData,
};
