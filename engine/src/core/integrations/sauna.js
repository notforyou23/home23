/**
 * Huum Sauna API Integration
 * Connects to your family's sauna via Huum cloud API
 */


function getBasicAuthHeader(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

/**
 * Fetch current sauna status
 * @param {Object} integrationConfig - Config from family_integrations table
 * @returns {Promise<Object>} Sauna status data
 */
async function fetchSaunaStatus(integrationConfig) {
  const { api_url, username, password } = integrationConfig;
  
  const url = `${api_url}/status`;
  const headers = {
    'Authorization': `Basic ${getBasicAuthHeader(username, password)}`,
    'Content-Type': 'application/json',
  };

  try {
    const response = await fetch(url, { method: 'GET', headers });
    
    if (!response.ok) {
      throw new Error(`Sauna API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Convert to dashboard-friendly format
    const temperatureFahrenheit = data.temperature 
      ? Math.round((parseFloat(data.temperature) * 9) / 5 + 32)
      : null;
    
    const targetTempFahrenheit = data.targetTemperature
      ? Math.round((parseFloat(data.targetTemperature) * 9) / 5 + 32)
      : null;

    return {
      status: getStatusText(data.statusCode),
      statusCode: data.statusCode,
      temperature: temperatureFahrenheit,
      targetTemperature: targetTempFahrenheit,
      duration: data.duration || 0,
      door: data.door,
      isHeating: data.statusCode === 231,
      isOffline: data.statusCode === 230,
      isLocked: data.statusCode === 233,
      isEmergency: data.statusCode === 400,
      rawData: data,
    };
  } catch (error) {
    console.error('Sauna API fetch failed:', error);
    throw error;
  }
}

/**
 * Toggle sauna on/off
 * @param {Object} integrationConfig - Config from family_integrations table  
 * @param {boolean} turnOn - true to start, false to stop
 * @param {number} targetTemp - Target temperature in Fahrenheit (default 190)
 * @param {number} duration - Duration in minutes (default 180)
 * @returns {Promise<Object>} Result of toggle operation
 */
async function toggleSauna(integrationConfig, turnOn, targetTemp = 190, duration = 180) {
  const { api_url, username, password } = integrationConfig;
  
  const endpoint = turnOn ? 'start' : 'stop';
  const url = `${api_url}/${endpoint}`;
  
  const headers = {
    'Authorization': `Basic ${getBasicAuthHeader(username, password)}`,
    'Content-Type': 'application/json',
  };

  const body = turnOn
    ? JSON.stringify({ 
        targetTemperature: ((targetTemp - 32) * 5) / 9, // Convert F to C
        duration 
      })
    : null;

  try {
    const response = await fetch(url, { 
      method: 'POST', 
      headers, 
      body 
    });

    if (!response.ok) {
      throw new Error(`Sauna toggle failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    return {
      success: true,
      action: turnOn ? 'started' : 'stopped',
      targetTemp: turnOn ? targetTemp : null,
      duration: turnOn ? duration : null,
      rawData: result,
    };
  } catch (error) {
    console.error('Sauna toggle failed:', error);
    throw error;
  }
}

function getStatusText(statusCode) {
  switch (statusCode) {
    case 230: return 'Offline';
    case 231: return 'Heating';
    case 232: return 'Off';
    case 233: return 'In Use (Locked)';
    case 400: return 'Emergency Stop';
    default: return 'Unknown';
  }
}

module.exports = {
  fetchSaunaStatus,
  toggleSauna,
};
