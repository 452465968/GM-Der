/**
 * 前端统一请求层
 *
 * 职责：封装 fetch，导出 get/post/put/patch/del/upload。
 * 约定：credentials: same-origin 携带会话 Cookie；非 2xx 抛出带服务端 error 文案的异常；
 * 所有视图模块都通过它访问后端，便于统一处理鉴权失败与错误提示。
 */
async function request(method, url, body) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: {},
  };

  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || '请求失败，请稍后重试');
    error.status = res.status;
    throw error;
  }
  return data;
}

export function get(url, params) {
  const query = new URLSearchParams();
  if (params) {
    Object.keys(params).forEach((key) => {
      const value = params[key];
      if (value !== '' && value !== null && value !== undefined) query.append(key, value);
    });
  }
  const qs = query.toString();
  return request('GET', qs ? `${url}?${qs}` : url);
}

export function post(url, body) {
  return request('POST', url, body);
}

export function patch(url, body) {
  return request('PATCH', url, body);
}

export function put(url, body) {
  return request('PUT', url, body);
}

export function del(url) {
  return request('DELETE', url);
}

export function upload(url, formData) {
  return request('POST', url, formData);
}
