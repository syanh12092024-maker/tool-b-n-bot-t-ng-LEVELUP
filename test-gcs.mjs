import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({
  keyFile: "config/firestore-key.json",
  scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
});

async function listBuckets() {
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  const r = await fetch("https://storage.googleapis.com/storage/v1/b?project=banbot-494807", {
    headers: { Authorization: "Bearer " + t.token },
  });
  const d = await r.json();
  if (d.items) {
    for (const b of d.items) {
      console.log("BUCKET:", b.name);
    }
  } else {
    console.log("Response:", JSON.stringify(d, null, 2));
  }
}

listBuckets();
