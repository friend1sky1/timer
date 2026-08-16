// 构建脚本：把 style.css 和 app.js 内联进 index.html，生成单文件版
// 用法：node build-single.js（在原型文件夹内运行）
// 产物：流程计时器-单文件版.html —— 一个文件，微信直发、双击即用
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

let out = html
  .replace('<link rel="stylesheet" href="style.css">', '<style>\n' + css + '\n</style>')
  .replace('<script src="app.js"></script>', '<script>\n' + js + '\n</script>');

// 校验：不应再残留外部引用
if (out.includes('href="style.css"') || out.includes('src="app.js"')) {
  console.error('FAIL: 内联替换未生效，仍有外部引用');
  process.exit(1);
}

const target = path.join(dir, '流程计时器-单文件版.html');
fs.writeFileSync(target, out);
console.log('PASS: 已生成 流程计时器-单文件版.html (' + (out.length / 1024).toFixed(1) + ' KB，单文件无外部依赖)');
