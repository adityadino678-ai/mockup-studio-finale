// Auth form handler for signin and signup pages
(function () {
  function setupForm(formId, apiPath, successUrl, successMsg) {
    var form = document.getElementById(formId);
    if (!form) return;
    var messageId = formId === "signin-form" ? "signin-message" : "signup-message";
    var message = document.getElementById(messageId);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var email = document.getElementById("email").value;
      var password = document.getElementById("password").value;
      var fullName = document.getElementById("fullName");
      var btn = form.querySelector("button[type=submit]");
      var originalText = btn.textContent;
      btn.textContent = successMsg === "Account created! Please sign in." ? "Creating account..." : "Signing in...";
      btn.disabled = true;
      var body = { email: email, password: password };
      if (fullName) body.fullName = fullName.value;
      fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, status: res.status, data: data };
          });
        })
        .then(function (result) {
          var data = result.data;
          if (!result.ok || (apiPath === "/api/auth/signin" ? !data.accessToken : !data.user)) {
            message.textContent = data.message || "Failed (" + result.status + ")";
            message.style.color = "var(--color-danger)";
            btn.textContent = originalText;
            btn.disabled = false;
            return;
          }
          message.textContent = successMsg;
          message.style.color = "var(--color-forest)";
          if (apiPath === "/api/auth/signup") {
            setTimeout(function () { window.location.href = "/auth/signin"; }, 1500);
          } else {
            window.location.href = successUrl;
          }
        })
        .catch(function (err) {
          message.textContent = err.message || "Failed";
          message.style.color = "var(--color-danger)";
          btn.textContent = originalText;
          btn.disabled = false;
        });
    });
  }
  setupForm("signin-form", "/api/auth/signin", "/printify-studio", "Signed in! Redirecting...");
  setupForm("signup-form", "/api/auth/signup", null, "Account created! Please sign in.");
})();
