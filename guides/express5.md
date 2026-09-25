# Upgrade to Express v5

Source: https://expressjs.com/en/guide/migrating-5.html
Retrieved for MajorTom Phase 4 doc-ingestion tests.

Express 5 is not very different from Express 4; although it maintains the same basic API,
there are still changes that break compatibility with the previous version. Therefore, an
application built with Express 4 might not work if you update it to use Express 5.

## Installation

To install this version, you need to have a **Node.js version 18 or higher**. Then, execute
the following command in your application directory:

```
npm install "express@5"
```

## Removed methods and properties

If you use any of these methods or properties in your app, it will crash. So, you'll need to
change your app after you update to version 5.

### app.del()

Express 5 no longer supports the `app.del()` function. If you use this function, an error is
thrown. For registering HTTP DELETE routes, use the `app.delete()` function instead.

Initially, `del` was used instead of `delete`, because `delete` is a reserved keyword in
JavaScript. However, as of ECMAScript 6, `delete` and other reserved keywords can legally be
used as property names.

```
// Before
app.del('/user/:id', (req, res) => {
  res.send(`DELETE /user/${req.params.id}`);
});
// After
app.delete('/user/:id', (req, res) => {
  res.send(`DELETE /user/${req.params.id}`);
});
```

### app.param(fn)

The `app.param(fn)` signature was used for modifying the behavior of the `app.param(name, fn)`
function. It has been deprecated since v4.11.0, and Express 5 no longer supports it at all.

### Pluralized method names

The following method names have been pluralized. In Express 4, using the old methods resulted
in a deprecation warning. Express 5 no longer supports them at all:

- `req.acceptsCharset()` is replaced by `req.acceptsCharsets()`.
- `req.acceptsEncoding()` is replaced by `req.acceptsEncodings()`.
- `req.acceptsLanguage()` is replaced by `req.acceptsLanguages()`.

```
// Before
req.acceptsCharset('utf-8');
req.acceptsEncoding('br');
req.acceptsLanguage('en');
// After
req.acceptsCharsets('utf-8');
req.acceptsEncodings('br');
req.acceptsLanguages('en');
```

### req.param(name)

This potentially confusing and dangerous method of retrieving form data has been removed. You
will now need to specifically look for the submitted parameter name in the `req.params`,
`req.body`, or `req.query` object.

```
// Before
const id = req.param('id');
const body = req.param('body');
const query = req.param('query');
// After
const id = req.params.id;
const body = req.body;
const query = req.query;
```

### res.json(obj, status)

Express 5 no longer supports the signature `res.json(obj, status)`. Instead, set the status
and then chain it to the `res.json()` method like this: `res.status(status).json(obj)`.

```
// Before
res.json({ name: 'Ruben' }, 201);
// After
res.status(201).json({ name: 'Ruben' });
```

### res.jsonp(obj, status)

Express 5 no longer supports the signature `res.jsonp(obj, status)`. Instead, set the status
and then chain it to the `res.jsonp()` method like this: `res.status(status).jsonp(obj)`.

```
// Before
res.jsonp({ name: 'Ruben' }, 201);
// After
res.status(201).jsonp({ name: 'Ruben' });
```

### res.redirect(url, status)

Express 5 no longer supports the signature `res.redirect(url, status)`. Instead, use the
following signature: `res.redirect(status, url)`.

```
// Before
res.redirect('/users', 302);
// After
res.redirect(302, '/users');
```

### res.redirect('back') and res.location('back')

Express 5 no longer supports the magic string `back` in the `res.redirect()` and
`res.location()` methods. Instead, use the `req.get('Referrer') || '/'` value to redirect
back to the previous page. In Express 4, the `res.redirect('back')` and
`res.location('back')` methods were deprecated.

```
// Before
res.redirect('back');
// After
res.redirect(req.get('Referrer') || '/');
```

### res.send(body, status)

Express 5 no longer supports the signature `res.send(obj, status)`. Instead, set the status
and then chain it to the `res.send()` method like this: `res.status(status).send(obj)`.

```
// Before
res.send({ name: 'Ruben' }, 200);
// After
res.status(200).send({ name: 'Ruben' });
```

### res.send(status)

Express 5 no longer supports the signature `res.send(status)`, where `status` is a number.
Instead, use the `res.sendStatus(statusCode)` function, which sets the HTTP response header
status code and sends the text version of the code.

```
// Before
res.send(200);
// After
res.sendStatus(200);
```

### res.sendfile()

The `res.sendfile()` function has been replaced by a camel-cased version `res.sendFile()` in
Express 5.

```
// Before
res.sendfile('/path/to/file');
// After
res.sendFile('/path/to/file');
```

## Changed

These APIs still exist but their behavior has changed. Review these changes to make sure your
app works as expected.

### Path route matching syntax

Path route matching syntax is when a string is supplied as the first parameter to the
`app.all()`, `app.use()`, `app.METHOD()`, `router.all()`, `router.METHOD()`, and
`router.use()` APIs. The following changes have been made to how the path string is matched
to an incoming request:

- The wildcard `*` must have a name, matching the behavior of parameters `:`, use `/*splat`
  instead of `/*`.
- The optional character `?` is no longer supported, use braces instead.
  Example: `/:file.:ext?` becomes `/:file{.:ext}`.
- Regexp characters are not supported. For example: `/[discussion|page]/:slug` becomes
  an array of paths `['/discussion/:slug', '/page/:slug']`.

```
// Before
app.get('/*', handler);
app.get('/:file.:ext?', handler);
// After
app.get('/*splat', handler);
app.get('/:file{.:ext}', handler);
```

### Rejected promises handled from middleware and handlers

Request middleware and handlers that return rejected promises are now handled by forwarding
the rejected value as an `Error` to the error handling middleware. This means that using
`async` functions as middleware and handlers are easier than ever. When an error is thrown in
an `async` function or a rejected promise is `await`ed inside an async function, those errors
will be passed to the error handler as if calling `next(err)`.

```
// Before
app.get('/user/:id', (req, res, next) => {
  getUserById(req.params.id)
    .then((user) => res.send(user))
    .catch(next);
});
// After
app.get('/user/:id', async (req, res) => {
  const user = await getUserById(req.params.id);
  res.send(user);
});
```

### express.urlencoded

The `express.urlencoded` method makes the `extended` option `false` by default.

```
// Before (implicit extended: true in Express 4)
app.use(express.urlencoded());
// After (set explicitly if needed)
app.use(express.urlencoded({ extended: true }));
```

### req.body

The `req.body` property returns `undefined` when the body has not been parsed. In Express 4,
it returns `{}` by default.

### res.status

The `res.status` method only accepts integers in the range of `100` to `999`, following the
behavior defined by Node.js, and it returns an error when the status code is not an integer.

### res.clearCookie

The `res.clearCookie` method ignores the `maxAge` and `expires` options provided by the user.

## Minimum Node.js version

Express 5 requires Node.js version 18 or higher. Update your `engines` field and any CI
configuration to reflect this requirement.

```json
{
  "engines": { "node": ">=18" }
}
```
