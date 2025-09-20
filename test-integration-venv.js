const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🧪 Testing Sidekick Pro Integration...\n');

// Paths
const backendPath = path.join(__dirname, 'backend');
const venvPython = path.join(backendPath, 'venv', 'Scripts', 'python.exe');
const mainPy = path.join(backendPath, 'app', 'main.py');

console.log('Using Python from venv:', venvPython);
console.log('Backend script:', mainPy);

// Check if venv Python exists
if (!fs.existsSync(venvPython)) {
    console.error('❌ Virtual environment Python not found!');
    console.log('Please activate venv and install dependencies first.');
    process.exit(1);
}

console.log('\nStarting Context Keeper backend...');

const pythonProcess = spawn(venvPython, [mainPy], {
    env: { 
        ...process.env,
        CONTEXT_KEEPER_PORT: '42000',
        PYTHONPATH: backendPath,
        PYTHONUNBUFFERED: '1'
    },
    cwd: backendPath
});

pythonProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log(`[Backend]: ${output.trim()}`);
});

pythonProcess.stderr.on('data', (data) => {
    const output = data.toString();
    if (!output.includes('INFO')) {
        console.error(`[Backend Error]: ${output.trim()}`);
    }
});

// Wait longer for backend with Docker services to start
setTimeout(async () => {
    console.log('\n📡 Testing API endpoints...');
    
    // The backend is running on port 8000 by default
    const port = 8000;
    
    try {
        const response = await fetch(`http://localhost:${port}/health`);
        const data = await response.json();
        console.log('✅ Health Check:', data);
        
        // Test stats endpoint
        const statsResponse = await fetch(`http://localhost:${port}/api/stats`);
        const stats = await statsResponse.json();
        console.log('✅ Stats:', stats);
        
        console.log('\n🎉 Backend is working correctly!');
    } catch (error) {
        console.error('❌ API test failed:', error.message);
    }
    
    console.log('\nStopping backend...');
    pythonProcess.kill();
    setTimeout(() => process.exit(0), 2000);
}, 10000);  // Wait 10 seconds for Docker services

console.log('Waiting for backend to start (10 seconds)...\n');
