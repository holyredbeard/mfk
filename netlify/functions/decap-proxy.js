// Basic structure for the Decap CMS proxy function
// We will add authentication and GitHub interaction logic here.

const { Octokit } = require("@octokit/rest");
const fetch = require("node-fetch"); // Needed by Octokit in some environments
const cookie = require("cookie");
const jwt = require("jsonwebtoken");

// Environment variables (set these in Netlify Build & deploy > Environment)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROXY_PASSWORD = process.env.DECAP_PROXY_PASSWORD;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g., "henrik56/monsterasfk"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "master"; // Default to master
const JWT_SECRET = process.env.JWT_SECRET; // A strong, random secret key for signing tokens
const AUTH_COOKIE_NAME = "decap_cms_auth";

// --- Authentication & Session Logic ---

// Function to verify the JWT token from the cookie
function verifyAuth(event) {
  if (!JWT_SECRET) {
    console.error("JWT_SECRET environment variable not set.");
    return null; // Config error, treat as unauthenticated
  }
  const cookies = cookie.parse(event.headers.cookie || "");
  const token = cookies[AUTH_COOKIE_NAME];

  if (!token) {
    return null; // No token, unauthenticated
  }

  try {
    jwt.verify(token, JWT_SECRET);
    return true; // Token is valid
  } catch (error) {
    console.warn("JWT verification failed:", error.message);
    return null; // Invalid token, unauthenticated
  }
}

// --- GitHub API Client ---
const octokit = new Octokit({ auth: GITHUB_TOKEN, request: { fetch } });

// --- Main Handler ---
exports.handler = async (event, context) => {
  const functionPath = event.path.replace('/.netlify/functions/decap-proxy', '') || '/';
  console.log("Decap Proxy invoked:", event.httpMethod, functionPath);

  // --- Input Validation (Basic) ---
  if (!GITHUB_REPO || !PROXY_PASSWORD || !JWT_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ message: "Server configuration error: Missing required environment variables." }) };
  }
  const [owner, repo] = GITHUB_REPO.split('/');
  if (!owner || !repo) {
    return { statusCode: 500, body: JSON.stringify({ message: "Server configuration error: Invalid GITHUB_REPO format." }) };
  }

  // --- Handle Login Request --- 
  if (event.httpMethod === "POST" && functionPath === '/login') {
    try {
      const { password } = JSON.parse(event.body || "{}");
      if (password === PROXY_PASSWORD) {
        // Password correct, create JWT
        const token = jwt.sign({ user: "authenticated" }, JWT_SECRET, { expiresIn: '1h' }); // Token valid for 1 hour
        
        // Set cookie and respond
        const authCookie = cookie.serialize(AUTH_COOKIE_NAME, token, {
          httpOnly: true, // Prevent client-side JS access
          secure: true,   // Only send over HTTPS
          path: '/',       // Available on all paths
          maxAge: 3600,   // 1 hour in seconds
          sameSite: 'Lax' // Good default for CSRF protection
        });

        console.log("Login successful, setting auth cookie.");
        return {
          statusCode: 200,
          headers: { 'Set-Cookie': authCookie },
          body: JSON.stringify({ message: "Login successful" })
        };
      } else {
        console.warn("Login attempt failed: Incorrect password.");
        return { statusCode: 401, body: JSON.stringify({ message: "Felaktigt lösenord." }) };
      }
    } catch (error) {
      console.error("Error processing login request:", error);
      return { statusCode: 400, body: JSON.stringify({ message: "Ogiltig inloggningsförfrågan." }) };
    }
  }

  // --- Check Authentication for all other requests ---
  const isAuthenticated = verifyAuth(event);
  if (!isAuthenticated) {
     // Not authenticated, redirect to login page (unless it's the login page itself)
    if (functionPath !== '/login') { // Avoid redirect loop
      console.log("User not authenticated, redirecting to login page.");
      return {
        statusCode: 302, // Found (Temporary Redirect)
        headers: {
          'Location': '/admin-login.html',
          // Clear potentially invalid cookie
          'Set-Cookie': cookie.serialize(AUTH_COOKIE_NAME, '', { httpOnly: true, secure: true, path: '/', expires: new Date(0) }) 
        },
        body: ''
      };
    }
    // If it *was* the login path but somehow failed verifyAuth, still deny access
     return { statusCode: 401, body: JSON.stringify({ message: "Authentication required." }) };
  }

  // --- Authenticated User: Handle Decap CMS API Requests ---
  console.log("User authenticated, proceeding with API request:", functionPath);
  try {
    // Reuse existing logic, but ensure functionPath matches expected Decap API paths
    if (event.httpMethod === "GET" && functionPath.startsWith('/content/')) {
      const filePath = functionPath.substring('/content/'.length);
      console.log(`Attempting to read file: ${filePath}`);
      const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref: GITHUB_BRANCH });
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return {
        statusCode: 200,
        body: content,
        headers: { 'Content-Type': 'application/json', 'ETag': data.sha },
      };
    } else if (event.httpMethod === "PUT" && functionPath.startsWith('/content/')) {
      const filePath = functionPath.substring('/content/'.length);
      console.log(`Attempting to write file: ${filePath}`);
      const requestBody = JSON.parse(event.body);
      const newContentBase64 = Buffer.from(JSON.stringify(requestBody.content, null, 2)).toString('base64');
      const commitMessage = requestBody.message || `Update ${filePath} via Decap CMS`;
      const currentSha = event.headers['if-match'];
      if (!currentSha) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing If-Match header (file SHA)." }) };
      }
      await octokit.repos.createOrUpdateFileContents({
        owner, repo, path: filePath, message: commitMessage, content: newContentBase64, sha: currentSha, branch: GITHUB_BRANCH,
      });
      return { statusCode: 200, body: JSON.stringify({ message: "File updated successfully" }) };
    } else if (event.httpMethod === "GET" && functionPath === '/media') {
      console.log("Handling GET request for /media. Returning empty list.");
      return { statusCode: 200, body: JSON.stringify([]) };
    } else {
      console.warn(`Unhandled authenticated path or method: ${event.httpMethod} ${functionPath}`);
      return { statusCode: 404, body: JSON.stringify({ message: "Not Found or Method Not Allowed by Proxy" }) };
    }
  } catch (error) {
    console.error("Error interacting with GitHub:", error);
    if (error.status === 404) {
      return { statusCode: 404, body: JSON.stringify({ message: `File not found on GitHub: ${error.message}` }) };
    } else if (error.status === 409) {
      return { statusCode: 409, body: JSON.stringify({ message: `Conflict updating file: ${error.message}` }) };
    }
    return { statusCode: 500, body: JSON.stringify({ message: `Internal Server Error: ${error.message}` }) };
  }
}; 