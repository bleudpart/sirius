const fs = require('fs');
const path = require('path');

test('read backend auth_api.py', () => {
  const backendDir = path.resolve(__dirname, '../../backend');
  const authApiPyPath = path.join(backendDir, 'auth_api.py');

  if (fs.existsSync(authApiPyPath)) {
    const authApiContent = fs.readFileSync(authApiPyPath, 'utf8');
    fs.writeFileSync(path.join(__dirname, 'temp_auth_api.txt'), authApiContent);
    console.log('Saved auth_api.py to temp_auth_api.txt');
  } else {
    console.log('auth_api.py not found at', authApiPyPath);
  }
});
