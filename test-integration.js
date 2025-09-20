const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 Testing Sidekick Pro Integration...\n');

// Start Context Keeper backend
const backendPath = path.join(__dirname, 'backend', 'app', 'main.py');
console.log('Starting Context Keeper backend...');

const python = spawn('python', [backendPath], {
    env: { 
        ...process.env,
        CONTEXT_KEEPER_PORT: '42000',
        PYTHONUNBUFFERED: '1'
    },
    cwd: path.join(__dirname, 'backend')
});

python.stdout.on('data', (data) => {
    console.log(`Backend: ${data.toString().trim()}`);
});

python.stderr.on('data', (data) => {
    console.error(`Backend Error: ${data.toString().trim()}`);
});

// Test after 5 seconds
setTimeout(async () => {
    console.log('\n📡 Testing API endpoints...');
    
    try {
        // Test health endpoint
        const health = await fetch('http://localhost:42000/health');
        const healthData = await health.json();
        console.log('✅ Health Check:', healthData);
        
        // Test stats endpoint
        const stats = await fetch('http://localhost:42000/api/stats');
        const statsData = await stats.json();
        console.log('✅ Stats:', statsData);
        
        console.log('\n🎉 Integration test successful!');
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
    
    // Cleanup
    python.kill();
    process.exit(0);
}, 5000);

console.log('Waiting for backend to start...\n');
