// 给老浏览器内核补上 DSH 前端用到的较新运行时 API。
//
// 目标内核：Android WebView 91 / 华为鸿蒙 4.2 的 ArkWeb 一类。
// 语法层（类静态块 static{}）由 esbuild 转译解决；这里补的是"运行时方法"。
//
// 设计要点：
//   ① 每段独立 try/catch —— 某段抛异常不能拖累其它段
//      （前一版 Iterator 那段一抛，structuredClone 等就全没补上）
//   ② 一律 globalThis.X = ... 显式挂全局，不依赖作用域推断
//   ③ 只补缺的，已有的一律不覆盖
//   ④ Iterator 那段单独隔离，最坏情况只影响它自己
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  function hasMethod(proto, name) {
    return proto && typeof proto[name] === 'function';
  }

  function define(target, name, fn) {
    try {
      Object.defineProperty(target, name, {
        value: fn, writable: true, enumerable: false, configurable: true,
      });
    } catch (e) {
      try { target[name] = fn; } catch (e2) { }
    }
  }

  // ---------------- Promise.withResolvers (Chrome 119) ----------------
  try {
    if (typeof Promise.withResolvers !== 'function') {
      define(Promise, 'withResolvers', function () {
        var resolve, reject;
        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
      });
    }
  } catch (e) { }

  // ---------------- Object.hasOwn (Chrome 93) ----------------
  try {
    if (typeof Object.hasOwn !== 'function') {
      define(Object, 'hasOwn', function (obj, prop) {
        if (obj === null || obj === undefined) {
          throw new TypeError('Cannot convert undefined or null to object');
        }
        return Object.prototype.hasOwnProperty.call(Object(obj), prop);
      });
    }
  } catch (e) { }

  // ---------------- Array.prototy / String.prototype.at (Chrome 92) ----------------
  try {
    if (!hasMethod(Array.prototype, 'at')) {
      define(Array.prototype, 'at', function (n) {
        var len = this.length >>> 0;
        var k = Math.trunc(n) || 0;
        if (k < 0) k += len;
        return (k < 0 || k >= len) ? undefined : this[k];
      });
    }
  } catch (e) { }
  try {
    if (!hasMethod(String.prototype, 'at')) {
      define(String.prototype, 'at', function (n) {
        var s = String(this);
        var k = Math.trunc(n) || 0;
        if (k < 0) k += s.length;
        return (k < 0 || k >= s.length) ? undefined : s.charAt(k);
      });
    }
  } catch (e) { }

  // ---------------- structuredClone (Chrome 98) ----------------
  try {
    if (typeof g.structuredClone !== 'function') {
      define(g, 'structuredClone', function (value) {
        if (value === undefined) return undefined;
        if (typeof value === 'function') throw new TypeError('function is not cloneable');
        return JSON.parse(JSON.stringify(value));
      });
    }
  } catch (e) { }

  // ---------------- AbortSignal.any (Chrome 116) / .timeout (Chrome 103) ----------------
  try {
    var AS = g.AbortSignal;
    if (AS) {
      if (typeof AS.any !== 'function') {
        define(AS, 'any', function (signals) {
          var ctrl = new AbortController();
          var list = Array.prototype.slice.call(signals || []);
          list.forEach(function (s) {
            if (!s) return;
            if (s.aborted) { try { ctrl.abort(s.reason); } catch (e) { ctrl.abort(); } return; }
            s.addEventListener('abort', function () {
              try { ctrl.abort(s.reason); } catch (e) { ctrl.abort(); }
            });
          });
          return ctrl.signal;
        });
      }
      if (typeof AS.timeout !== 'function') {
        define(AS, 'timeout', function (ms) {
          var ctrl = new AbortController();
          setTimeout(function () {
            try { ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')); }
            catch (e) { ctrl.abort(); }
          }, ms);
          return ctrl.signal;
        });
      }
      if (typeof AS.prototype.throwIfAborted !== 'function') {
        define(AS.prototype, 'throwIfAborted', function () {
          if (this.aborted) throw this.reason;
        });
      }
    }
  } catch (e) { }

  // ---------------- WeakRef (Chrome 84) ----------------
  try {
    if (typeof g.WeakRef !== 'function') {
      define(g, 'WeakRef', function (o) { this._o = o; });
      define(g.WeakRef.prototype, 'deref', function () { return this._o; });
    }
  } catch (e) { }

  // ---------------- 数组新方法 ----------------
  try {
    if (!hasMethod(Array.prototype, 'findLast')) {
      define(Array.prototype, 'findLast', function (fn, t) {
        for (var i = this.length - 1; i >= 0; i--) if (fn.call(t, this[i], i, this)) return this[i];
        return undefined;
      });
    }
    if (!hasMethod(Array.prototype, 'findLastIndex')) {
      define(Array.prototype, 'findLastIndex', function (fn, t) {
        for (var i = this.length - 1; i >= 0; i--) if (fn.call(t, this[i], i, this)) return i;
        return -1;
      });
    }
    if (!hasMethod(Array.prototype, 'toReversed')) {
      define(Array.prototype, 'toReversed', function () { return this.slice().reverse(); });
    }
    if (!hasMethod(Array.prototype, 'toSorted')) {
      define(Array.prototype, 'toSorted', function (c) { return this.slice().sort(c); });
    }
    if (!hasMethod(Array.prototype, 'toSpliced')) {
      define(Array.prototype, 'toSpliced', function () {
        var a = this.slice();
        return Array.prototype.splice.apply(a, arguments);
      });
    }
    if (!hasMethod(Array.prototype, 'with')) {
      define(Array.prototype, 'with', function (i, v) {
        var a = this.slice();
        a[i < 0 ? a.length + i : i] = v;
        return a;
      });
    }
  } catch (e) { }

  // ---------------- Object.groupBy / Map.groupBy (Chrome 117) ----------------
  try {
    if (typeof Object.groupBy !== 'function') {
      define(Object, 'groupBy', function (items, fn) {
        var out = Object.create(null);
        var i = 0;
        Array.prototype.slice.call(items).forEach(function (item) {
          var k = fn(item, i++);
          if (!out[k]) out[k] = [];
          out[k].push(item);
        });
        return out;
      });
    }
    if (typeof Map.groupBy !== 'function') {
      define(Map, 'groupBy', function (items, fn) {
        var out = new Map();
        var i = 0;
        Array.prototype.slice.call(items).forEach(function (item) {
          var k = fn(item, i++);
          if (!out.has(k)) out.set(k, []);
          out.get(k).push(item);
        });
        return out;
      });
    }
  } catch (e) { }

  // ---------------- Iterator 与迭代器助手 (Chrome 122) ----------------
  // 单独一大段并整体隔离：这段最可能抛（要改内建原型），
  // 万一失败也只影响 Iterator，不能影响上面已经补好的 API。
  try {
    if (typeof g.Iterator === 'undefined') {
      // 迭代器包装器：把任意迭代器包成带助手的对象
      function wrap(iter) {
        var o = Object.create(ITER_PROTO);
        o.__it = iter;
        return o;
      }

      function self() { return this.__it; }

      var ITER_PROTO = {
        next: function () { return this.__it.next(); },
        map: function (fn) {
          var inner = this.__it;
          return wrap((function* () { var i = 0; for (var v of iterableOf(inner)) yield fn(v, i++); })());
        },
        filter: function (fn) {
          var inner = this.__it;
          return wrap((function* () { var i = 0; for (var v of iterableOf(inner)) if (fn(v, i++)) yield v; })());
        },
        take: function (n) {
          var inner = this.__it;
          return wrap((function* () { var i = 0; for (var v of iterableOf(inner)) { if (i++ >= n) return; yield v; } })());
        },
        drop: function (n) {
          var inner = this.__it;
          return wrap((function* () { var i = 0; for (var v of iterableOf(inner)) { if (i++ >= n) yield v; } })());
        },
        flatMap: function (fn) {
          var inner = this.__it;
          return wrap((function* () { var i = 0; for (var v of iterableOf(inner)) { var r = fn(v, i++); for (var x of r) yield x; } })());
        },
        reduce: function (fn, init) {
          var acc = init, first = arguments.length < 2;
          for (var v of iterableOf(this.__it)) {
            if (first) { acc = v; first = false; } else acc = fn(acc, v);
          }
          return acc;
        },
        toArray: function () { var a = []; for (var v of iterableOf(this.__it)) a.push(v); return a; },
        forEach: function (fn) { var i = 0; for (var v of iterableOf(this.__it)) fn(v, i++); },
        some: function (fn) { var i = 0; for (var v of iterableOf(this.__it)) if (fn(v, i++)) return true; return false; },
        every: function (fn) { var i = 0; for (var v of iterableOf(this.__it)) if (!fn(v, i++)) return false; return true; },
        find: function (fn) { var i = 0; for (var v of iterableOf(this.__it)) if (fn(v, i++)) return v; return undefined; },
        join: function (sep) { return this.toArray().join(sep); },
      };
      // 让包装对象本身可迭代
      define(ITER_PROTO, Symbol.iterator, self);

      function iterableOf(it) {
        var o = {};
        o[Symbol.iterator] = function () { return it; };
        return o;
      }

      var It = function () { };
      It.prototype = ITER_PROTO;
      It.from = function (v) {
        if (v === null || v === undefined) throw new TypeError('Iterator.from: value is not iterable');
        var it = (typeof v[Symbol.iterator] === 'function') ? v[Symbol.iterator]() : v;
        return wrap(it);
      };
      It.concat = function () {
        var all = [];
        Array.prototype.slice.call(arguments).forEach(function (a) {
          if (a != null) all = all.concat(Array.prototype.slice.call(a));
        });
        return wrap(all[Symbol.iterator]());
      };
      define(g, 'Iterator', It);

      // 顺带把内建迭代器升级成带助手的版本（PDF.js 会直接 .values().map(...)）
      try {
        if (hasMethod(Array.prototype, 'values')) {
          var av = Array.prototype.values;
          define(Array.prototype, 'values', function () { return wrap(av.call(this)); });
        }
        if (hasMethod(Array.prototype, 'keys')) {
          var ak = Array.prototype.keys;
          define(Array.prototype, 'keys', function () { return wrap(ak.call(this)); });
        }
        if (hasMethod(Array.prototype, 'entries')) {
          var ae = Array.prototype.entries;
          define(Array.prototype, 'entries', function () { return wrap(ae.call(this)); });
        }
        if (g.Map && hasMethod(Map.prototype, 'values')) {
          var mv = Map.prototype.values, mk = Map.prototype.keys, me = Map.prototype.entries;
          define(Map.prototype, 'values', function () { return wrap(mv.call(this)); });
          define(Map.prototype, 'keys', function () { return wrap(mk.call(this)); });
          define(Map.prototype, 'entries', function () { return wrap(me.call(this)); });
        }
        if (g.Set && hasMethod(Set.prototype, 'values')) {
          var sv = Set.prototype.values, sk = Set.prototype.keys, se = Set.prototype.entries;
          define(Set.prototype, 'values', function () { return wrap(sv.call(this)); });
          define(Set.prototype, 'keys', function () { return wrap(sk.call(this)); });
          define(Set.prototype, 'entries', function () { return wrap(se.call(this)); });
        }
      } catch (e) { }
    } else {
      // 有 Iterator 但缺助手
      var IP = g.Iterator.prototype;
      if (IP) {
        if (!hasMethod(IP, 'toArray')) define(IP, 'toArray', function () { return Array.from(this); });
        if (!hasMethod(IP, 'forEach')) define(IP, 'forEach', function (fn) { var i = 0; for (var v of this) fn(v, i++); });
        if (!hasMethod(IP, 'join')) define(IP, 'join', function (sep) { return Array.from(this).join(sep); });
        if (!hasMethod(IP, 'map')) define(IP, 'map', function (fn) {
          var src = this;
          return (function* () { var i = 0; for (var v of src) yield fn(v, i++); })();
        });
        if (!hasMethod(IP, 'filter')) define(IP, 'filter', function (fn) {
          var src = this;
          return (function* () { var i = 0; for (var v of src) if (fn(v, i++)) yield v; })();
        });
        if (!hasMethod(IP, 'take')) define(IP, 'take', function (n) {
          var src = this;
          return (function* () { var i = 0; for (var v of src) { if (i++ >= n) return; yield v; } })();
        });
        if (!hasMethod(IP, 'drop')) define(IP, 'drop', function (n) {
          var src = this;
          return (function* () { var i = 0; for (var v of src) { if (i++ >= n) yield v; } })();
        });
      }
    }
  } catch (e) {
    try { console.error('[legacy-polyfill] Iterator 补丁失败:', e && e.message); } catch (x) { }
  }
})();
