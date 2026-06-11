import React, { useState, useEffect } from 'react';

const defaultSession = {
  label: '',
  host: '',
  port: '22',
  user: '',
  password: '',
  identityFile: '',
  group: 'Default',
  extraArgs: '',
};

export default function SessionDialog({ session, onSave, onClose, existingGroups = [] }) {
  const [form, setForm] = useState({ ...defaultSession });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (session) {
      setForm({
        ...defaultSession,
        ...session,
        port: String(session.port || 22),
      });
    } else {
      setForm({ ...defaultSession });
    }
    setErrors({});
  }, [session]);

  const set = (field) => (e) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const validate = () => {
    const errs = {};
    if (!form.host.trim()) errs.host = 'Host is required';
    const port = parseInt(form.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) errs.port = 'Invalid port';
    return errs;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    const data = {
      ...form,
      port: parseInt(form.port, 10),
      label: form.label.trim() || form.host.trim(),
    };
    if (session?.id) data.id = session.id;
    onSave(data);
  };

  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">
          {session ? 'Edit Session' : 'Add New Session'}
          <button
            type="button"
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}
            title="关闭"
          >✕</button>
        </div>

        <form onSubmit={handleSubmit} autoComplete="off">
          {/* Label */}
          <div className="form-group">
            <label className="form-label">Label</label>
            <input
              className="form-input"
              type="text"
              placeholder="My Server (optional)"
              value={form.label}
              onChange={set('label')}
              autoFocus
            />
          </div>

          {/* Host + Port */}
          <div className="form-row">
            <div className="form-group" style={{ flex: 3 }}>
              <label className="form-label">
                Hostname / IP
                {errors.host && (
                  <span style={{ color: 'var(--danger)', marginLeft: 8, fontWeight: 400, textTransform: 'none' }}>
                    {errors.host}
                  </span>
                )}
              </label>
              <input
                className={`form-input mono ${errors.host ? 'error' : ''}`}
                type="text"
                placeholder="192.168.1.1 or example.com"
                value={form.host}
                onChange={set('host')}
                style={errors.host ? { borderColor: 'var(--danger)' } : {}}
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">
                Port
                {errors.port && (
                  <span style={{ color: 'var(--danger)', marginLeft: 4, fontWeight: 400, textTransform: 'none' }}>
                    !
                  </span>
                )}
              </label>
              <input
                className="form-input mono"
                type="number"
                min="1"
                max="65535"
                value={form.port}
                onChange={set('port')}
                style={errors.port ? { borderColor: 'var(--danger)' } : {}}
              />
            </div>
          </div>

          {/* Username */}
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              className="form-input mono"
              type="text"
              placeholder="root (leave blank for current user)"
              value={form.user}
              onChange={set('user')}
            />
          </div>

          {/* Password */}
          <div className="form-group">
            <label className="form-label">
              Password
              <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, textTransform: 'none' }}>
                留空则连接时手动输入
              </span>
            </label>
            <input
              className="form-input mono"
              type="password"
              placeholder="可选，保存后自动填充"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
            />
          </div>

          {/* Identity file */}
          <div className="form-group">
            <label className="form-label">Identity File (SSH Key)</label>
            <input
              className="form-input mono"
              type="text"
              placeholder="~/.ssh/id_rsa (optional)"
              value={form.identityFile}
              onChange={set('identityFile')}
            />
          </div>

          {/* Group */}
          <div className="form-group">
            <label className="form-label">分组</label>
            <input
              className="form-input"
              type="text"
              placeholder="Default"
              value={form.group}
              onChange={set('group')}
              list="group-suggestions"
            />
            <datalist id="group-suggestions">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>

          {/* Extra args */}
          <div className="form-group">
            <label className="form-label">
              Extra SSH Arguments
              <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, textTransform: 'none' }}>
                e.g. -A -L 8080:localhost:8080
              </span>
            </label>
            <input
              className="form-input mono"
              type="text"
              placeholder="-A -o ServerAliveInterval=30"
              value={form.extraArgs}
              onChange={set('extraArgs')}
            />
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              {session ? 'Save Changes' : 'Add Session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
