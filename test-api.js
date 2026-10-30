const axios = require('axios');

const BASE_URL = 'http://localhost:5000/api';

// Test Credentials
const TEST_USER = {
  email: 'qwert@gmail.com', // Apna test email likhein
  password: '12345678'     // Apna test password likhein
};

async function runFullSystemTest() {
  console.log('🚀 Starting 100% Automated System Test...\n');

  try {
    // STEP 1: Test Login & Get JWT Token
    console.log('1️⃣ Testing Auth Login...');
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, TEST_USER);
    
    const token = loginRes.data.token || loginRes.data.accessToken;
    if (!token) throw new Error('JWT Token not received in login response!');
    console.log('✅ Login Successful! JWT Token acquired.');

    // Axios instance with Header setup
    const authAxios = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}` }
    });

    // STEP 2: Test Add Contact with sourceAd
    console.log('\n2️⃣ Testing POST /contacts/add (Ad Tracking)...');
    const addContactRes = await authAxios.post('/contacts/add', {
      name: 'Automation Test Lead',
      phone: '03265064864',
      group: 'facebook ads',
      sourceAd: 'Summer_Sale_2026',
      tags: ['AutoTest', 'Lead']
    });
    console.log('✅ Contact Added Response:', addContactRes.data.message);

    // STEP 3: Test Get Contacts with Filter
    console.log('\n3️⃣ Testing GET /contacts?sourceAd=Summer_Sale_2026...');
    const getContactsRes = await authAxios.get('/contacts?sourceAd=Summer_Sale_2026');
    console.log(`✅ Filtered Contacts Found: ${getContactsRes.data.contacts.length} record(s)`);

    // STEP 4: Test Chats Aggregation Route
    console.log('\n4️⃣ Testing GET /chats (Group & sourceAd Aggregation)...');
    const getChatsRes = await authAxios.get('/chats');
    console.log(`✅ Chats Fetched Successfully: ${getChatsRes.data.chats.length} active chat(s)`);

    console.log('\n🎉 =================================== 🎉');
    console.log('   ALL TESTS PASSED WITH 100% SUCCESS!');
    console.log('🎉 =================================== 🎉');

  } catch (error) {
    console.error('\n❌ TEST FAILED!');
    if (error.response) {
      console.error('API Error Response:', error.response.status, error.response.data);
    } else {
      console.error('Error Message:', error.message);
    }
  }
}

runFullSystemTest();