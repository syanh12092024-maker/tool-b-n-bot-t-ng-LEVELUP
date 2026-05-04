const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function test() {
  // Test freeimage.host
  try {
    const fd1 = new FormData();
    fd1.append("source", b64);
    fd1.append("type", "base64");
    fd1.append("action", "upload");
    const r1 = await fetch("https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5", { method: "POST", body: fd1 });
    const t1 = await r1.text();
    console.log("freeimage status:", r1.status, "body:", t1.slice(0, 300));
  } catch(e) {
    console.log("freeimage ERROR:", e.message);
  }

  // Test imgbb
  try {
    const fd2 = new FormData();
    fd2.append("image", b64);
    const r2 = await fetch("https://api.imgbb.com/1/upload?key=3e45a6f8c4e5d6a7b8c9d0e1f2a3b4c5", { method: "POST", body: fd2 });
    const t2 = await r2.text();
    console.log("imgbb status:", r2.status, "body:", t2.slice(0, 300));
  } catch(e) {
    console.log("imgbb ERROR:", e.message);
  }
}

test();
