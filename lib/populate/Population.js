'use strict';

const async   = require ('async')
  , _         = require ('underscore')
  , pluralize = require ('pluralize')
  ;

function Population (populators) {
  this._populators = populators;
  this._ids = {};
  this.population = {};
}

Population.getKeyFromModel = function (model) {
  return model.db.name + ':' + model.modelName;
};

module.exports = Population;

Population.prototype.flatten = function (callback) {
  async.mapValues (this.population, function (values, key, callback) {
    return callback (null, _.flatten (values));
  }, callback);
};

Population.prototype.populateElement = function (key, model, callback) {
  const populator = this._populators[key];

  if (!populator)
    return callback (null);

  this._populate (populator, model, callback);
};

Population.prototype.populateArray = function (key, arr, callback) {
  const populator = this._populators[key];

  if (!populator)
    return callback (null);

  // Iterate over each element in the array, and populate each one. The
  // partial result can be ignored since we are will be adding the populated
  // object directly to the result.
  async.each (arr, function (model, callback) {
    this._populate (populator, model, callback);
  }.bind (this), callback);
};

Population.prototype._populate = function (populator, data, callback) {
  if (!data)
    return callback (null);

  async.eachOf (populator, function (populate, path, callback) {
    const value  = data[path];

    if (!value)
      return callback (null);

    const plural = pluralize (populate.Model.modelName);

    // Make sure the result and ids for the current population exists. If not,
    // then we start with the default array.

    if (!this.population[plural])
      this.population[plural] = [];

    if (!this._ids[plural])
      this._ids[plural] = [];

    async.waterfall ([
      // Determine the ids that we need to search for.
      function (callback) {
        populate.accept ({
          visitPopulateElement: function () {
            const idStr = value.toString ();
            const coll = this._ids[plural];

            if (coll.indexOf (idStr) !== -1)
              return callback (null, null);

            coll.push (idStr);

            return callback (null, value);
          }.bind (this),

          visitPopulateArray: function () {
            const coll = this._ids[plural];

            async.filter (value, function (id, callback) {
              const idStr = id.toString ();
              const firstTime = coll.indexOf (idStr) === -1;

              if (firstTime)
                coll.push (idStr);

              return callback (null, firstTime);
            }, complete);

            function complete (err, result) {
              return callback (err, result.length > 0 ? result : null);
            }
          }.bind (this)
        })
      }.bind (this),

      // Populate populate the remaining ids.
      function (remaining, callback) {
        if (!remaining)
          return callback (null);

        async.waterfall ([
          function (callback) {
            populate.populate (remaining, callback);
          },

          function (model, callback) {
            this.population[plural].push (model);

            const key = Population.getKeyFromModel (populate.Model);

            if (_.isArray (model))
              this.populateArray (key, model, callback);
            else
              this.populateElement (key, model, callback);
          }.bind (this)
        ], callback);
      }.bind (this)
    ], callback);
  }.bind (this), callback);
};