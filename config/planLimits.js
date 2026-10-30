// config/planLimits.js
const PLAN_LIMITS = {
  price_free: {
    contactsLimit: 100,
    flowBuildersLimit: 0,
    canUseShopify: false,
    canUseApi: false,
    canUseAi: false,
  },
  price_standard: {
    contactsLimit: 150000,
    flowBuildersLimit: 5,
    canUseShopify: true,
    canUseApi: true,
    canUseAi: false,
  },
  price_premium: {
    contactsLimit: 1000000,
    flowBuildersLimit: Infinity, // Unlimited
    canUseShopify: true,
    canUseApi: true,
    canUseAi: true,
  },
  price_ultimate: {
    contactsLimit: Infinity,
    flowBuildersLimit: Infinity,
    canUseShopify: true,
    canUseApi: true,
    canUseAi: true,
  }
};

module.exports = PLAN_LIMITS;