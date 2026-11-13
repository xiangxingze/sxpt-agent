const PATCH_FENCE = /```ptn-patch\s*\n([\s\S]*?)```/g;
const NEWFILE_FENCE = /```ptn-newfile\s*\n([\s\S]*?)```/g;

const text =
  '好的，改这里：\n\n```ptn-patch\nfile: src/a.cs\n<<<<<<< SEARCH\n    var user = new User\n=======\n    Validate(dto);\n    var user = new User\n>>>>>>> REPLACE\n```\n\n完成。\n\n```ptn-newfile\nfile: src/b.cs\nnamespace X { class B {} }\n```';

let m;
let n = 0;
while ((m = PATCH_FENCE.exec(text)) !== null) {
  const body = m[1];
  const f = body.match(/^\s*file:\s*(.+)$/m);
  const s = body.match(/<{7}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={7}\s*\r?\n([\s\S]*?)\r?\n>{7}\s*REPLACE/);
  console.log('file =', f && f[1]);
  console.log('search =', JSON.stringify(s && s[1]));
  console.log('replace =', JSON.stringify(s && s[2]));
  n++;
}
console.log('patch count:', n);

let nf;
while ((nf = NEWFILE_FENCE.exec(text)) !== null) {
  const body = nf[1];
  const f = body.match(/^\s*file:\s*(.+)$/m);
  console.log('newfile =', f && f[1].trim(), '| content =', JSON.stringify(body.slice(body.indexOf('\n') + 1)));
}
