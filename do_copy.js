const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'deploy-69e626c7c329364d3066599e', 'index.html');
const dst = path.join(__dirname, 'apps', 'edge', 'public', 'index.html');

console.log('Source:', src);
console.log('Dest:', dst);

const content = fs.readFileSync(src, 'utf8');
console.log('Read', content.length, 'bytes');

fs.writeFileSync(dst, content, 'utf8');
console.log('Written successfully!');
