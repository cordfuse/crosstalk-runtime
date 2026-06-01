Name:           crosstalk-runtime
Version:        %{version_placeholder}
Release:        1%{?dist}
Summary:        AI agent messaging daemon
License:        MIT
URL:            https://github.com/cordfuse/crosstalk-runtime
Source0:        crosstalk-linux-%{arch_placeholder}

Requires:       git, openssh

%description
Watches Crosstalk transport repos, dispatches messages to AI agent CLIs
(Claude, Gemini, etc.), and commits replies back. Runs as a system daemon.

%prep
# Nothing to prep — pre-built binary

%install
install -Dm755 %{SOURCE0} %{buildroot}/usr/bin/crosstalk
install -Dm644 %{_sourcedir}/crosstalk.service %{buildroot}/usr/lib/systemd/system/crosstalk.service
install -dm755 %{buildroot}/etc/crosstalk
install -dm755 %{buildroot}/var/lib/crosstalk

%pre
# Create system user
getent passwd crosstalk >/dev/null || \
  useradd --system --no-create-home --shell /sbin/nologin \
    --home-dir /var/lib/crosstalk crosstalk
exit 0

%post
mkdir -p /var/lib/crosstalk/workspaces /var/lib/crosstalk/.ssh
chown -R crosstalk /var/lib/crosstalk
chmod 700 /var/lib/crosstalk/.ssh

systemctl daemon-reload >/dev/null 2>&1 || true
systemctl enable crosstalk.service >/dev/null 2>&1 || true

echo ""
echo "crosstalk-runtime installed."
echo "Next: sudo crosstalk install <git-url>"
echo ""

%preun
if [ $1 -eq 0 ]; then
  systemctl stop crosstalk.service >/dev/null 2>&1 || true
  systemctl disable crosstalk.service >/dev/null 2>&1 || true
fi

%postun
systemctl daemon-reload >/dev/null 2>&1 || true

%files
/usr/bin/crosstalk
/usr/lib/systemd/system/crosstalk.service
%dir /etc/crosstalk
%dir /var/lib/crosstalk
