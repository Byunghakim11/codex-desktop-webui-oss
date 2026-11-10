// Deterministic parser fixture, never actual user document content.
export function syntheticPdf(){
  const stream=page=>`BT /F1 18 Tf 20 140 Td (Synthetic P2 PDF page ${page}) Tj ET`;
  const objects=["<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>","<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",...[6,7].map(content=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`),"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",...[1,2].map(page=>`<< /Length ${Buffer.byteLength(stream(page))} >>\nstream\n${stream(page)}\nendstream`),"<< /S /JavaScript /JS (app.alert\\(SYNTHETIC_SCRIPT_MUST_NOT_RUN\\)) >>"];
  let body="%PDF-1.4\n",offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(value=>`${String(value).padStart(10,"0")} 00000 n \n`).join("")+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(body);
}
