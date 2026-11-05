/**
 * Stripe API Integration
 * 
 * Example of a custom integration handler with business logic.
 * 
 * Methods:
 * - customers.list - List customers
 * - customers.create - Create customer
 * - charges.list - List charges
 * - invoices.upcoming - Get upcoming invoice
 */

const GenericRESTIntegration = require('./generic-rest');

class StripeIntegration extends GenericRESTIntegration {
  constructor(config, logger) {
    // Set Stripe-specific defaults
    config.baseURL = 'https://api.stripe.com/v1';
    config.auth = {
      type: 'bearer',
      token: config.apiKey || process.env.STRIPE_SECRET_KEY
    };
    
    super(config, logger);
    this.description = 'Stripe Payment API';
    
    // Stripe rate limits
    this.rateLimit = {
      maxCalls: 100,
      windowMs: 1000 // 100 calls per second
    };
  }

  /**
   * Override call to handle Stripe-specific logic
   */
  async call(method, params = {}) {
    // Map friendly method names to Stripe API paths
    const methodMap = {
      'customers.list': 'GET /customers',
      'customers.create': 'POST /customers',
      'customers.retrieve': 'GET /customers/:id',
      'charges.list': 'GET /charges',
      'charges.create': 'POST /charges',
      'invoices.upcoming': 'GET /invoices/upcoming',
      'subscriptions.list': 'GET /subscriptions',
      'products.list': 'GET /products'
    };
    
    const apiMethod = methodMap[method] || method;
    
    // Replace :id placeholder if present
    let finalMethod = apiMethod;
    if (apiMethod.includes(':id') && params.id) {
      finalMethod = apiMethod.replace(':id', params.id);
      delete params.id;
    }
    
    try {
      const result = await super.call(finalMethod, params);
      return result;
    } catch (error) {
      // Add Stripe-specific error handling
      if (error.statusCode === 429) {
        throw new Error('Stripe rate limit exceeded. Please try again later.');
      }
      throw error;
    }
  }

  /**
   * Get available methods
   */
  getMethods() {
    return [
      'customers.list',
      'customers.create',
      'customers.retrieve',
      'charges.list',
      'charges.create',
      'invoices.upcoming',
      'subscriptions.list',
      'products.list'
    ];
  }

  /**
   * Custom health check for Stripe
   */
  async healthCheck() {
    try {
      // Try to list customers with limit 1
      await this.call('customers.list', { limit: 1 });
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = StripeIntegration;

