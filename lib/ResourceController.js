var util      = require ('util')
  , async     = require ('async')
  , _         = require ('underscore')
  , pluralize = require ('pluralize')
  , blueprint = require ('@onehilltech/blueprint')
  ;

var validationSchema = require ('./ValidationSchema');
var populate = require ('./populate');

var BaseController = blueprint.ResourceController
  , HttpError = blueprint.errors.HttpError
  , messaging = blueprint.messaging
  ;

/**
 * Test if the projection is exclusive. An exclusive projection only has to
 * have one key that is false (or 0). Any empty projection is exclusive as well,
 * meaning that all fields will be included.
 *
 * @param projection
 * @returns {*}
 */
function isProjectionExclusive (projection) {
  var keys = Object.keys (projection);

  if (keys.length === 0)
    return true;

  var value = projection[keys[0]];
  return value === false || value === 0;
}

function __onAuthorize (req, callback) { return callback (null); }
function __onPrepareProjection (req, callback) { return callback (null, {}); }
function __onPrepareOptions (req, callback) { return callback (null, {}); }
function __onUpdateFilter (req, filter, callback) { return callback (null, filter); }
function __onPrepareDocument (req, doc, callback) {
  return callback (null, doc);
}
function __onPostExecute (req, result, callback) { return callback (null, result); }

function checkIdThenAuthorize (id, next) {
  return function __blueprint_checkIdThenAuthorize (req, callback) {
    if (!req.params[id])
      return callback (new HttpError (400, 'Missing resource id'));

    return next (req, callback);
  }
}
/**
 * Make the database completion handler. We have to create a new handler
 * for each execution because we need to bind to a different callback.
 *
 * @param callback
 * @returns {Function}
 */
function makeDbCompletionHandler (errMsg, callback) {
  return function __blueprint_db_execution_complete (err, result) {
    if (err) return callback (new HttpError (400, errMsg));
    if (!result) return callback (new HttpError (404, 'Not Found'));

    return callback (null, result);
  }
}

/**
 * Make the handler that executes after the async.waterfall tasks is complete. We
 * cannot reuse the same method since we have to bind to a different res object
 * for each request.
 *
 * @param res
 * @returns {Function}
 */
function makeTaskCompletionHandler (res, callback) {
  return function __blueprint_task_complete (err, result) {
    if (err) return callback (err);

    res.status (200).json (result);
  }
}

function makeOnPreCreateHandler (req, onPreCreate) {
  return function __blueprint_on_prepare_document (doc, callback) {
    return onPreCreate (req, doc, callback);
  };
}

/**
 * @class ResourceController
 *
 * Base class f or all resource controllers.
 *
 * @param opts
 * @constructor
 */
function ResourceController (opts) {
  BaseController.call (this);

  opts = opts || {};

  if (!opts.model)
    throw new Error ('Options must define model property');

  this._id = opts.id;
  this._model = opts.model;
  this.name = opts.name || opts.model.modelName;
  this._pluralize = pluralize (this.name);
  this._eventPrefix = opts.eventPrefix;

  if (!this._id)
    this._id = this.name + 'Id';

  // Build the validation schema for create and update.
  var validationOpts = {pathPrefix: this.name};
  this._createValidation = validationSchema (opts.model.schema, validationOpts);
  this._updateValidation = validationSchema (opts.model.schema, _.extend (validationOpts, {allOptional: true}));
}

util.inherits (ResourceController, BaseController);

/**
 * Get the resource identifier.
 */
ResourceController.prototype.__defineGetter__ ('resourceId', function () {
  return this._id;
});

/**
 * Create a new resource.
 *
 * @param opts
 * @returns
 */
ResourceController.prototype.create = function (opts) {
  opts = opts || {};
  var on = opts.on || {};

  if (on.preCreate)
    winston.log ('warn', 'on.preCreate is deprecated; use on.prepareDocument instead');

  var onPrepareDocument = on.preCreate || on.prepareDocument || __onPrepareDocument;
  var onPostExecute = on.postExecute || __onPostExecute;
  var onAuthorize = on.authorize || __onAuthorize;
  var eventName = this.computeEventName ('created');

  var self = this;

  return {
    validate: function (req, callback) {
      async.series ([
        // First, validate the input based on the target model. If any part of the
        // schema validation fails, we return as
        function (callback) {
          req.checkBody (self._createValidation);
          return callback (req.validationErrors ());
        },

        // Next, allow the subclass to perform its own validation.
        function (callback) {
          onAuthorize (req, callback);
        }
      ], callback);
    },

    execute: function __blueprint_create (req, res, callback) {
      var doc = req.body[self.name];

      async.waterfall ([
        async.constant (doc),

        function (doc, callback) {
          async.waterfall ([
            // First, remove all elements from the body that are not part of
            // the target model.
            function (callback) {
              return callback (null, doc);
            },

            function (doc, callback) {
              return onPrepareDocument (req, doc, callback);
            }
          ], callback);
        },

        // Now, let's search our database for the resource in question.
        function (doc, callback) {
          self._model.create (doc, makeDbCompletionHandler ('Failed to create resource', callback));
        },

        // Allow the subclass to do any post-execution analysis of the result.
        function (result, callback) {
          // Emit that a resource was created.
          messaging.emit (eventName, result);

          onPostExecute (req, result, callback);
        },

        // Serialize the data in REST format.
        function (data, callback) {
          var result = {};

          data = data.toJSON ? data.toJSON () : (data.toObject ? data.toObject () : data);
          result[self.name] = _.omit (data, '__v');

          return callback (null, result);
        }
      ], makeTaskCompletionHandler (res, callback));
    }
  }
};

/**
 * Get a single resource.
 *
 * @param opts
 * @returns
 */
ResourceController.prototype.get = function (opts) {
  opts = opts || {};
  var on = opts.on || {};

  if (on.updateFilter)
    winston.log ('warn', 'on.updateFilter is deprecated; use on.prepareFilter instead');

  var onAuthorize = on.authorize || __onAuthorize;
  var onPrepareProjection = on.prepareProjection || __onPrepareProjection;
  var onUpdateFilter = on.updateFilter || on.prepareFilter || __onUpdateFilter;
  var onPostExecute = on.postExecute || __onPostExecute;

  var self = this;

  return {
    validate: checkIdThenAuthorize (self._id, onAuthorize),

    execute: function __blueprint_get_execute (req, res, callback) {
      var rcId = req.params[self._id];
      var filter = {_id: rcId};

      async.waterfall ([
        // First, allow the subclass to update the filter.
        async.constant (filter),

        function (filter, callback) {
          return onUpdateFilter (req, filter, callback)
        },

        // Prepare the projection, and then execute the database command.
        function (filter, callback) {
          onPrepareProjection (req, function (err, projection) {
            // Do not include the version field in the projection.
            if (isProjectionExclusive (projection) && projection['__v'] === undefined)
              projection['__v'] = 0;

            self._model.findOne (filter, projection, makeDbCompletionHandler ('Failed to retrieve resource', callback));
          });
        },

        // Allow the subclass to do any post-execution analysis of the result.
        function (result, callback) {
          onPostExecute (req, result, callback);
        },

        // Rewrite the result in JSON API format.
        function (data, callback) {
          var result = { };
          result[self.name] = data;

          if (!req.query.populate) {
            return callback (null, result);
          }
          else {
            return populate (data, self._model, function (err, details) {
              result = _.extend (result, details);
              return callback (null, result);
            });
          }
        }
      ], makeTaskCompletionHandler (res, callback));
    }
  };
};

/**
 * Get a list of the resources, if not all.
 *
 * @param opts
 * @returns
 */
ResourceController.prototype.getAll = function (opts) {
  opts = opts || {};
  var on = opts.on || {};

  if (on.updateFilter)
    winston.log ('warn', 'on.updateFilter is deprecated; use on.prepareFilter instead');

  var onAuthorize = on.authorize || __onAuthorize;
  var onUpdateFilter = on.updateFilter || on.prepareFilter || __onUpdateFilter;
  var onPrepareProjection = on.prepareProjection || __onPrepareProjection;
  var onPrepareOptions = on.prepareOptions || __onPrepareOptions;
  var onPostExecute = on.postExecute || __onPostExecute;

  var self = this;

  return {
    // There is no resource id that needs to be validated. So, we can
    // just pass control to the onAuthorize method.
    validate: onAuthorize,

    execute: function __blueprint_getall_execute (req, res, callback) {
      // Update the options with those from the query string.
      var opts = req.query.options || {};

      async.waterfall ([
        async.constant (_.omit (req.query, ['options'])),

        function (filter, callback) {
          return onUpdateFilter (req, filter, callback)
        },

        // Now, let's search our database for the resource in question.
        function (filter, callback) {
          onPrepareOptions (req, function (err, options) {
            if (err) return callback (err);
            options = options || {};

            if (opts.skip)
              options['skip'] = opts.skip;

            if (opts.limit)
              options['limit'] = opts.limit;

            if (opts.sort)
              options['sort'] = opts.sort;

            onPrepareProjection (req, function (err, projection) {
              if (err) return callback (err);

              // Do not include the version field in the projection.
              if (isProjectionExclusive (projection))
                projection['__v'] = 0;

              self._model.find (filter, projection, options, makeDbCompletionHandler ('Failed to retrieve resource', callback));
            });
          });
        },

        // Allow the subclass to do any post-execution analysis of the result.
        function (result, callback) { onPostExecute (req, result, callback); },

        // Rewrite the result in JSON API format.
        function (data, callback) {
          var result = { };
          result[self._pluralize] = data;

          if (!opts.populate) {
            return callback (null, result);
          }
          else {
            return populate (data, self._model, function (err, details) {
              result = _.extend (result, details);
              return callback (null, result);
            });
          }
        }
      ], makeTaskCompletionHandler (res, callback));
    }
  };
};

/**
 * Update a single resource.
 *
 * @param opts
 * @returns
 */
ResourceController.prototype.update = function (opts) {
  opts = opts || {};
  var on = opts.on || {};

  if (on.updateFilter)
    winston.log ('warn', 'on.updateFilter is deprecated; use on.prepareFilter instead');

  var onUpdateFilter = on.updateFilter || on.prepareFilter || __onUpdateFilter;
  var onPostExecute = on.postExecute || __onPostExecute;
  var onAuthorize = on.authorize || __onAuthorize;
  var onPrepareProjection = on.prepareProjection || __onPrepareProjection;

  var eventName = this.computeEventName("updated");

  var self = this;

  return {
    validate: checkIdThenAuthorize (self._id, function (req, callback) {
      async.series ([
        // First, validate the input based on the target model. If any part of the
        // schema validation fails, we return as
        function (callback) {
          req.checkBody (self._updateValidation);
          var errors = req.validationErrors ();

          return callback (errors);
        },

        // Next, allow the subclass to perform its own validation.
        function (callback) {
          onAuthorize (req, callback);
        }
      ], callback);
    }),

    execute: function __blueprint_update_execute (req, res, callback) {
      var rcId = req.params[self._id];
      var filter = {_id: rcId};

      async.waterfall ([
        // First, allow the subclass to update the filter.
        async.constant (filter),

        function (filter, callback) {
          return onUpdateFilter (req, filter, callback)
        },

        // Now, let's search our database for the resource in question.
        function (filter, callback) {
          var update = { $set: req.body[self.name] };
          var option = { upsert: false, new: true };

          onPrepareProjection (req, function (err, projection) {
            // Do not include the version field in the projection.
            option.fields = projection;

            if (isProjectionExclusive (projection) && projection['__v'] === undefined)
              option.fields.__v = 0;

            self._model.findOneAndUpdate (filter, update, option, makeDbCompletionHandler ('Failed to update resource', callback));
          });
        },

        // Allow the subclass to do any post-execution analysis of the result.
        function (result, callback) {
          messaging.emit (eventName, result);
          onPostExecute (req, result, callback);
        },

        // Rewrite the result in JSON API format.
        function (data, callback) {
          var result = { };
          result[self.name] = data;

          return callback (null, result);
        }
      ], makeTaskCompletionHandler (res, callback));
    }
  };
};

/**
 * Delete a single resource.
 *
 * @param opts
 * @returns
 */
ResourceController.prototype.delete = function (opts) {
  opts = opts || {};
  var on = opts.on || {};

  if (on.updateFilter)
    winston.log ('warn', 'on.updateFilter is deprecated; use on.prepareFilter instead');

  var onUpdateFilter = on.updateFilter || on.prepareFilter || __onUpdateFilter;
  var onPostExecute = on.postExecute || __onPostExecute;
  var onAuthorize = on.authorize || __onAuthorize;
  var eventName = this.computeEventName ('deleted');
  var self = this;

  return {
    validate: checkIdThenAuthorize (self._id, onAuthorize),

    execute: function __blueprint_delete (req, res, callback) {
      var rcId = req.params[self._id];
      var filter = {_id: rcId};

      async.waterfall ([
        // First, allow the subclass to update the filter.
        async.constant (filter),

        function (filter, callback) {
          return onUpdateFilter (req, filter, callback)
        },

        // Now, let's search our database for the resource in question.
        function (filter, callback) {
          self._model.findOneAndRemove (filter, makeDbCompletionHandler ('Failed to delete resource', callback));
        },

        // Allow the subclass to do any post-execution analysis of the result.
        function (result, callback) {
          // Emit that a resource was created.
          messaging.emit (eventName, result);

          onPostExecute (req, result, callback);
        },

        // Make sure we return 'true'.
        function (result, callback) { return callback (null, true); }
      ], makeTaskCompletionHandler (res, callback));
    }
  };
};

/**
 * Count the number of resources.
 *
 * @param opts
 * @returns
 */
ResourceController.prototype.count = function (opts) {
  opts = opts || {};
  var on = opts.on || {};

  if (on.updateFilter)
    winston.log ('warn', 'on.updateFilter is deprecated; use on.prepareFilter instead');

  var onAuthorize = on.authorize || __onAuthorize;
  var onUpdateFilter = on.updateFilter || on.prepareFilter || __onUpdateFilter;
  var onPostExecute = on.postExecute || __onPostExecute;

  var self = this;

  return {
    // There is no resource id that needs to be validated. So, we can
    // just pass control to the onAuthorize method.
    validate: onAuthorize,

    execute: function __blueprint_count_execute (req, res, callback) {
      async.waterfall ([
        async.constant (req.query),

        function (filter, callback) {
          return onUpdateFilter (req, filter, callback)
        },

        // Now, let's search our database for the resource in question.
        function (filter, callback) {
          self._model.count (filter, makeDbCompletionHandler ('Failed to count resources', callback));
        },

        // Allow the subclass to do any post-execution analysis of the result.
        function (count, callback) { onPostExecute (req, count, callback); },

        // Rewrite the result in JSON API format.
        function (count, callback) {
          return callback (null, {count: count});
        }
      ], makeTaskCompletionHandler (res, callback));
    }
  };
};

/**
 * Get the first resource that matches the criteria, if specified.
 *
 * @param action
 */
ResourceController.prototype.getFirst = function (opts) {
  opts = opts || {};
  var on = opts.on || {};

  if (on.updateFilter)
    winston.log ('warn', 'on.updateFilter is deprecated; use on.prepareFilter instead');

  var onAuthorize = on.authorize || __onAuthorize;
  var onUpdateFilter = on.updateFilter || on.prepareFilter || __onUpdateFilter;
  var onPostExecute = on.postExecute || __onPostExecute;

  var self = this;

  return {
    // There is no resource id that needs to be validated. So, we can
    // just pass control to the onAuthorize method.
    validate: onAuthorize,

    execute: function __blueprint_getFirst_execute (req, res, callback) {
      async.waterfall ([
        async.constant (req.query),

        function (filter, callback) {
          return onUpdateFilter (req, filter, callback)
        },

        // Now, let's search our database for the resource in question.
        function (filter, callback) {
          var options = req.query.options;

          if (options)
            filter = _.omit (req.query, ['options']);

          options = options || {};

          var query = self._model.find (filter).select ({__v: 0}).limit (1);

          if (options.sort)
            query.sort (options.sort);

          query.exec (makeDbCompletionHandler ('Failed to count resources', callback));
        },

        // Allow the subclass to do any post-execution analysis of the result.
        function (first, callback) { onPostExecute (req, first, callback); },

        // Rewrite the result in JSON API format.
        function (first, callback) {
          var result = {};
          result[self.name] = first[0];

          return callback (null, result);
        }
      ], makeTaskCompletionHandler (res, callback));
    }
  };
};

ResourceController.prototype.computeEventName = function (action) {
  var prefix = this._eventPrefix || '';

  if (prefix.length !== 0)
    prefix += '.';

  return prefix + this.name + '.' + action;
};

module.exports = exports = ResourceController;
